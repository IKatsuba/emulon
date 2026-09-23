# Security policy

Emulon is a development and testing tool. It is designed to run on loopback with
local credentials and must not be exposed to untrusted networks or used in
production.

Security issues are still taken seriously, especially ones that could leak
secrets from a developer machine, let a local emulator reach a real provider, or
let a web page interact with a running environment.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/IKatsuba/emulon/security/advisories/new).
Include the affected versions, a description of the impact and steps to
reproduce.

You can expect an acknowledgement within a few days. Fixes are released for the
latest published version.
