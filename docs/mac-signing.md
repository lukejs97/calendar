# Signing the Mac app with your own certificate

Signing every build with the same certificate makes each update the *same
app* to macOS for its privacy permissions: Calendars, Reminders and Location
(Settings → Apple Calendar, Time to leave) stay allowed after updates.

What it **doesn't** fix: the keychain still asks for your password after each
update, once per saved sign-in. The keychain only recognises an update as the
same app by its Apple **Team ID**, which only Apple-issued Developer ID
certificates carry (the Apple Developer Program, $99 a year). A self-made
certificate has none, so the keychain goes by each build's exact fingerprint,
which changes every time. A Developer ID certificate would also make the
"Open Anyway" step unnecessary (notarization).

This is a free, self-made certificate, not an Apple Developer one. Only the
app is signed with it; the `.dmg` is left unsigned, as a disk image signed
with a certificate macOS doesn't know would need "Open Anyway" as well.

## One-time setup

1. On your Mac, open **Terminal** and run this (it makes the certificate,
   copies it to the clipboard, and deletes the files it made):

   ```bash
   cd "$(mktemp -d)" && cat > minuteman.cnf <<'EOF'
   [req]
   distinguished_name = dn
   x509_extensions = ext
   prompt = no
   [dn]
   CN = Minuteman Signing
   [ext]
   basicConstraints = critical,CA:false
   keyUsage = critical,digitalSignature
   extendedKeyUsage = critical,codeSigning
   EOF
   /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config minuteman.cnf -keyout minuteman.key -out minuteman.crt \
     && /usr/bin/openssl pkcs12 -export -inkey minuteman.key -in minuteman.crt -name "Minuteman Signing" -passout pass:minuteman -out minuteman.p12 \
     && base64 -i minuteman.p12 | pbcopy \
     && echo "Copied to the clipboard." ; rm -f minuteman.*
   ```

2. On GitHub, open the repository's **Settings → Secrets and variables →
   Actions → New repository secret**. Name it `MAC_SIGNING_CERT`, paste the
   clipboard as its value, and click **Add secret**.

3. Run **Build macOS app** again. Its "Show how the app is signed" step should
   say `Authority=Minuteman Signing`.

4. Install that build. When macOS asks for keychain access, enter your
   password and click **Always Allow** (not **Allow**). It asks again after
   each update (see above).

## Notes

- The certificate is valid for 10 years. The `.p12` password (`minuteman`) is
  in the workflow on purpose: the secret is the file, which only GitHub has.
- Keep the repository secret. Anyone with the certificate could sign an app
  that macOS treats as Minuteman, with the Calendar, Reminders and Location
  access you gave it.
- If you make a new certificate, macOS asks for those permissions again.
- The build uses it in `.github/workflows/build-macos.yml`: it imports it into
  a keychain of its own and sets `APPLE_SIGNING_IDENTITY` for Tauri. (Tauri's
  own `APPLE_CERTIFICATE` import only accepts Apple-issued certificates.)
