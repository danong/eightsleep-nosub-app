# Agent guidance

## Start here

Read `README.md` for the product behavior, setup, deployment, and repository layout. Inspect the relevant implementation and tests before changing a behavior.

## Making changes

- Treat authentication, token storage, and bed control as safety-sensitive. Preserve their existing guarantees when changing routes, hosting, or scheduling; add regression tests for behavior changes.
- Keep the UI and API contract in sync. Validate inputs and enforce authorization on the server, including when changing where the UI is hosted.
- Update `README.md` when setup, deployment, or user-visible behavior changes. Run the checks documented there before finishing.
