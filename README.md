# Fill from Phone Extension

This repository contains the Manifest V3 Chrome receiver for Fill from Phone. It binds one user-selected editable field, establishes an end-to-end encrypted transfer, inserts one returned value, and never submits the destination form.

## Boundaries

- The selected field and ephemeral private key stay in the content script.
- Relay requests are made by the service worker; the field receiver has no direct network path.
- The test-page marker carries no identifier or authority.
- There is no remote code, analytics, persistent storage permission, or externally connectable surface.

Field type is classified locally as `short-text`, `long-text`, or `password`, authenticated end to end, and omitted from relay requests.

## Build and verify

Node.js 24 or later is required.

```bash
npm ci
npm run check
npm audit --audit-level=high
```

`npm run build` writes the runtime to `dist/` and byte-identical generic and versioned ZIPs to `release/`.

## Related implementation

The relay and phone endpoint are in [FillFromPhone-Core](https://github.com/AsanoWharton/FillFromPhone-Core). Website code is in [FillFromPhone-Site](https://github.com/AsanoWharton/FillFromPhone-Site).

## Ownership

The source is public for review and remains proprietary. See `PROPRIETARY-NOTICE.txt`.
