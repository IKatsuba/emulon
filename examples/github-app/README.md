# Local GitHub App

From the repository root, run **deno task example:github-app**.

The application provisions a local GitHub App and installation, obtains an
installation token through Octokit, creates an issue and accepts its signed
webhook. It inspects the successful delivery, explicitly redelivers it, waits
for success again and inspects both attempts. The output's `deliveryInspections`
shows one attempt before redelivery and two afterward, with receiver status 204
and provider delivery IDs. `redeliveredWebhook.signatureVerified: true` confirms
that the receiver also verified the repeated `issues` webhook.

It then submits the local consent form, validates callback state, exchanges the
code on the web endpoint with Octokit, reads the fixture user and creates a
second issue with that user's token on the API endpoint. It verifies the user
issue webhook too, prints both issues, the user and events, then closes the
environment and receiver. Credentials are never printed. Ports are dynamically
allocated on loopback; no account or external credentials are needed.

The same application runs inside **deno task check**. See
[client configuration and compatibility](../../docs/github-compatibility.md).
