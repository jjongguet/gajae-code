### Fixed

- Release the cross-process OAuth refresh lease when a token refresh fails, and keep credentials active when their OAuth provider has not registered yet.
- Give each OAuth refresh attempt its own lease owner, and only let a refresh failure that predates an attempt block it, so a refresh waiting on a failed peer's lease can still succeed.
