# C2PA trust anchors

The two PEM files are the official C2PA and timestamp authority trust lists published by the [C2PA Conformance Program](https://github.com/c2pa-org/conformance-public/tree/f61352d703c756f4caa176ce3cbccc41a085c11a/trust-list). Both snapshots come from commit `f61352d703c756f4caa176ce3cbccc41a085c11a` and were retrieved on 2026-11-21. Refresh both files from the same official revision when the trust lists change.

The verifier uses these bundled certificates and embedded credential data locally. It does not fetch remote manifests or online OCSP responses while reading an upload.
