import urllib.request
import json

data = json.dumps({
    'title': '🔒 Add Secure attribute to session cookies',
    'body': '''
🎯 **What:** The session and clear cookie generation functions were missing the \`Secure\` attribute in the `Set-Cookie` header.
⚠️ **Risk:** Without the \`Secure\` attribute, session cookies could be sent over plain HTTP connections instead of HTTPS, potentially allowing attackers to intercept them in plain text over unencrypted networks.
🛡️ **Solution:** Appended \`; Secure\` to the cookie strings in \`src/dashboard/handler.ts\`, \`src/dashboard/tenant-handler.ts\`, and \`src/portal/portal-handler.ts\`. Updated their respective tests to assert that the attribute is present.
'''
}).encode('utf-8')

req = urllib.request.Request(
    'http://localhost:3000/api/pulls',
    data=data,
    headers={'Content-Type': 'application/json'}
)
try:
    with urllib.request.urlopen(req) as response:
        print(response.read().decode())
except Exception as e:
    print(e)
