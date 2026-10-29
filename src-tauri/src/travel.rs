//! Mac only: driving times for "time to leave" alerts, from the Mac's location
//! (Core Location) to an event's place, as Apple Maps reckons them (MapKit).
//!
//! Core Location and MapKit want to be used from the main thread, where their
//! answers also arrive; `on_main` runs work there and waits for the answer.

use std::cell::RefCell;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use chrono::{DateTime, Local};
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_core_location::{
    CLAuthorizationStatus, CLLocationCoordinate2D, CLLocationManager, kCLLocationAccuracyHundredMeters,
};
use objc2_foundation::{NSDate, NSError, NSString};
use objc2_map_kit::{
    MKCoordinateRegion, MKDirections, MKDirectionsRequest, MKDirectionsTransportType, MKETAResponse,
    MKLocalSearch, MKLocalSearchRequest, MKLocalSearchResponse, MKMapItem,
};
use serde::Serialize;
use tauri::AppHandle;

/// How long to wait for Apple Maps before giving up on a travel time.
const TIMEOUT: Duration = Duration::from_secs(20);
/// Places are looked for within this distance of where you are (metres).
const SEARCH_RADIUS: f64 = 100_000.0;

thread_local! {
    /// Lives on the main thread while time-to-leave is on.
    static MANAGER: RefCell<Option<Retained<CLLocationManager>>> = const { RefCell::new(None) };
}

/// Runs `f` on the main thread and waits for its answer, which it sends
/// itself (possibly later, from a completion handler).
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(tokio::sync::oneshot::Sender<T>) + Send + 'static,
) -> Option<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || f(tx)).ok()?;
    tokio::time::timeout(TIMEOUT, rx).await.ok()?.ok()
}

/// Whether Minuteman may use the Mac's location.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    NotAsked,
    Granted,
    Denied,
}

pub fn access() -> Access {
    #[allow(deprecated)]
    match unsafe { CLLocationManager::authorizationStatus_class() } {
        CLAuthorizationStatus::NotDetermined => Access::NotAsked,
        CLAuthorizationStatus::AuthorizedAlways | CLAuthorizationStatus::AuthorizedWhenInUse => Access::Granted,
        _ => Access::Denied,
    }
}

/// Starts following the Mac's location (roughly: to the nearest 100 m),
/// asking for permission the first time.
pub fn start(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        MANAGER.with(|manager| {
            let mut manager = manager.borrow_mut();
            if manager.is_some() {
                return;
            }
            let new = unsafe { CLLocationManager::new() };
            unsafe {
                new.setDesiredAccuracy(kCLLocationAccuracyHundredMeters);
                new.setDistanceFilter(200.0);
                new.requestAlwaysAuthorization();
                new.startUpdatingLocation();
            }
            *manager = Some(new);
        });
    });
}

/// Stops following the location (time-to-leave turned off).
pub fn stop(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        MANAGER.with(|manager| {
            if let Some(manager) = manager.borrow_mut().take() {
                unsafe { manager.stopUpdatingLocation() };
            }
        });
    });
}

/// Minutes to drive from here to `place`, arriving at `arrive`, as Apple Maps
/// reckons them (with traffic). `None` if the place can't be found, there's
/// no location yet, or Maps doesn't answer.
pub async fn driving_minutes(app: &AppHandle, place: String, arrive: DateTime<Local>) -> Option<u32> {
    let here = on_main(app, |tx| {
        let here = MANAGER.with(|manager| {
            let manager = manager.borrow();
            let location = unsafe { manager.as_ref()?.location()? };
            Some(unsafe { location.coordinate() })
        });
        let _ = tx.send(here.map(|c| (c.latitude, c.longitude)));
    })
    .await??;

    let seconds = on_main(app, move |tx| {
        let tx = Mutex::new(Some(tx));
        // Called once, by whichever step ends it (found, not found, or failed).
        let send: Arc<dyn Fn(Option<f64>)> = Arc::new(move |seconds| {
            if let Some(tx) = tx.lock().expect("not poisoned").take() {
                let _ = tx.send(seconds);
            }
        });
        unsafe {
            let center = CLLocationCoordinate2D { latitude: here.0, longitude: here.1 };
            let request = MKLocalSearchRequest::initWithNaturalLanguageQuery_region(
                MKLocalSearchRequest::alloc(),
                &NSString::from_str(&place),
                MKCoordinateRegion::with_distance(center, SEARCH_RADIUS, SEARCH_RADIUS),
            );
            let search = MKLocalSearch::initWithRequest(MKLocalSearch::alloc(), &request);
            let found = {
                let send = send.clone();
                // The search keeps itself (and so this block) alive until it answers.
                let search_alive = search.clone();
                RcBlock::new(move |response: *mut MKLocalSearchResponse, _error: *mut NSError| {
                    let _ = &search_alive;
                    let Some(response) = response.as_ref() else { return send(None) };
                    let Some(destination) = response.mapItems().firstObject() else { return send(None) };
                    eta(&destination, arrive, send.clone());
                })
            };
            search.startWithCompletionHandler(RcBlock::as_ptr(&found));
        }
    })
    .await??;

    // Rounded up, so "8 min" isn't really 8½.
    Some((seconds / 60.0).ceil().max(0.0) as u32)
}

/// Asks Apple Maps for the driving time from here to `destination`; `send`
/// gets the seconds (or `None`).
unsafe fn eta(destination: &MKMapItem, arrive: DateTime<Local>, send: Arc<dyn Fn(Option<f64>)>) {
    unsafe {
        let request = MKDirectionsRequest::new();
        request.setSource(Some(&MKMapItem::mapItemForCurrentLocation()));
        request.setDestination(Some(destination));
        request.setTransportType(MKDirectionsTransportType::Automobile);
        request.setArrivalDate(Some(&NSDate::dateWithTimeIntervalSince1970(arrive.timestamp() as f64)));
        let directions = MKDirections::initWithRequest(MKDirections::alloc(), &request);
        let directions_alive = directions.clone();
        let done = RcBlock::new(move |response: *mut MKETAResponse, _error: *mut NSError| {
            let _ = &directions_alive;
            send(response.as_ref().map(|r| r.expectedTravelTime()));
        });
        directions.calculateETAWithCompletionHandler(RcBlock::as_ptr(&done));
    }
}

/// Whether `place` is somewhere you'd travel to, not a video call or a link.
pub fn is_physical(place: &str) -> bool {
    let place = place.trim().to_lowercase();
    !place.is_empty()
        && !place.contains("://")
        && !["zoom", "meet.google", "teams", "webex", "facetime", "online", "virtual", "phone", "call"]
            .iter()
            .any(|word| place.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_places_need_travel() {
        assert!(is_physical("Cafe Roma, 12 High St"));
        assert!(!is_physical("https://zoom.us/j/123"));
        assert!(!is_physical("Microsoft Teams Meeting"));
        assert!(!is_physical("  "));
    }
}
