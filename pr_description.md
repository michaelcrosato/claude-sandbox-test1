🔒 Fix: Missing Secure attribute on tenant dashboard session cookie

🎯 **What:**
The `sessionCookie` and `clearCookie` functions in the `src/dashboard/tenant-handler.ts` file explicitely set `HttpOnly` and `SameSite=Strict` attributes for the tenant dashboard session cookie, but omitted the `Secure` attribute. This change appends the `Secure` attribute to the cookie definitions.

⚠️ **Risk:**
Without the `Secure` attribute, the session cookie could potentially be transmitted over unencrypted HTTP connections if the application is not strictly enforcing HTTPS in all scenarios. This could lead to a Man-in-the-Middle (MitM) attack where an attacker intercepts the session cookie and uses it to impersonate the user or perform unauthorized actions on the tenant dashboard.

🛡️ **Solution:**
The fix addresses the vulnerability by appending the `; Secure` string to the cookie value returned by both the `sessionCookie` and `clearCookie` functions. This instructs the browser to only transmit the cookie over secure, encrypted (HTTPS) connections.

Additionally, the unit tests have been updated in `src/dashboard/tenant-handler.test.ts` to assert that the `Secure` attribute is properly set on the login response cookie.
