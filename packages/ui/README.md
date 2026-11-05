# Browser workspace

The [intake server](../intake/README.md) serves [index.html](index.html), the browser modules, and the API from one origin. [serve.js](serve.js) handles known page routes and assets, so opening a request deep link directly loads the same workspace.

- [src/workspace/](src/workspace/) renders the guideline library, collections, bookmarks, recent views, and request lists. The reference content is illustrative. Bookmarks and viewing history are stored in the browser.
- [src/app.js](src/app.js) manages Cognito sign-in, the verified profile, and requests to the intake API. It keeps access tokens in memory and clears displayed request data when the session expires.
- [src/tracking.js](src/tracking.js) presents the intake stages and available actions for the selected revision. Confirmation displays the queued handoff. Clinical approval and release are downstream stages.

## Try the workspace

From the repository root, use Node.js 22.18 or later and run:

```sh
npm ci
node packages/ui/test/test-server.js
```

Open [the fixture workspace](http://127.0.0.1:3197). The test server uses synthetic identities, in-memory storage, and an injected screener. Restarting it clears its requests. For Cognito and AWS storage, follow the [intake setup](../intake/README.md#run-locally-against-aws).

Run `node --test packages/ui/test/*.test.js` for controller and HTTP integration coverage. HTTP tests need a loopback port. See the [UI migration notes](../../docs/ui-migration/README.md) for browser journeys and supported routes.

## Follow a request

1. Open **New request**, choose a baseline, and submit requirements with an optional guideline attachment. An uncertain submission can be retried with the same payload and idempotency key.
2. Find the request under **Local protocols** or **Configuration requests**. The request list groups revisions by request ID. The detail view reads the selected revision's screening and preview status.
3. Run screening explicitly and make a correction if required. Corrections create a revision under the same request. Reopen the latest revision before previewing it.
4. Confirm the exact preview after reviewing it. If the revision has changed, the workspace reloads the history and review state so the user can inspect the current revision.

The browser routes and API share an origin. For a deep-link or missing-asset issue, inspect [serve.js](serve.js) and [workspace/boot.js](src/workspace/boot.js). For repeated requests or stale review state, inspect [the controller tests](test/controller.test.js) and [the request integration tests](test/requests.test.js).
