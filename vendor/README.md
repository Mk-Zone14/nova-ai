# Vendored third-party scripts

These files are self-hosted so the page never executes JavaScript from a third-party CDN
(see `script-src 'self'` in `vercel.json`). They are unmodified builds taken from the npm
registry tarballs listed below.

| File | npm package | Path inside tarball | SHA-256 |
|---|---|---|---|
| `pdf.min.js` | `pdfjs-dist@3.11.174` | `build/pdf.min.js` | `5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946` |
| `pdf.worker.min.js` | `pdfjs-dist@3.11.174` | `build/pdf.worker.min.js` | `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b` |
| `html2pdf.bundle.min.js` | `html2pdf.js@0.10.1` | `dist/html2pdf.bundle.min.js` | `85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65` |
| `lucide.min.js` | `lucide@0.468.0` | `dist/umd/lucide.min.js` | `3411692820cb8d47543f69496aa25fd603a358f4498046f41c508a5a3342210e` |

## Updating

```bash
npm pack pdfjs-dist@<version> html2pdf.js@<version> lucide@<version>
# extract each tarball, copy the files above, then update the versions and hashes in this table
sha256sum vendor/*.min.js
```

`test/quality.test.js` fails if a file here no longer matches its recorded hash.
