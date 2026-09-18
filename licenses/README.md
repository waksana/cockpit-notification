# Bundled license supplement

The `http_ece@1.2.0` npm archive declares MIT but omits its LICENSE file.
`http_ece-LICENSE` preserves the upstream text at the npm package's `gitHead`:

https://github.com/web-push-libs/encrypted-content-encoding/blob/0562510a30819f52424724a6fd5504becacd98a1/LICENSE

The build checks that exact package version before using this supplement.
Other bundled dependency licenses are copied from their locked installed packages
into `dist/licenses`; no runtime license downloads are required.
