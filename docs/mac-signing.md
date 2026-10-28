# Signing the Mac app with your own certificate

Minuteman keeps your Google and Todoist sign-ins in the macOS keychain. The
keychain lets an app read its items without asking only if it's the *same
app* that was allowed before, which macOS judges by the app's signature.

Without a certificate, each build is signed "ad hoc": every build gets a
different signature, so after each update macOS asks for your password once
per saved sign-in. With a certificate of your own, every build carries the
same signature. Click **Always Allow** once and later updates don't ask.

This is a free, self-made certificate, not an Apple Developer one. It doesn't
change the "Open Anyway" step the first time you open a download.

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

4. Install that build. The first time it opens, macOS asks once more for each
   saved sign-in; enter your password and click **Always Allow** (not
   **Allow**). Updates after that won't ask.

## Notes

- The certificate is valid for 10 years. The `.p12` password (`minuteman`) is
  in the workflow on purpose: the secret is the file, which only GitHub has.
- Keep the repository secret. Anyone with the certificate could sign an app
  that macOS treats as Minuteman, and read its keychain items without asking.
- If you make a new certificate, macOS asks one more time, as above.
- The build uses it in `.github/workflows/build-macos.yml`: it imports it into
  a keychain of its own and sets `APPLE_SIGNING_IDENTITY` for Tauri. (Tauri's
  own `APPLE_CERTIFICATE` import only accepts Apple-issued certificates.)
