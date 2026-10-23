# On-disk archive verification (Haus NVR 0.3.5)

A helper can retain recent media locally and archive older original/prepared files on NVR nodes. Before releasing local bytes it needs evidence that an actual persisted remote file matches its digest. A filename, successful HEAD request, upload acknowledgement, or recording catalog entry is not such evidence.

The existing authenticated HMAC API adds an empty-body endpoint:

```text
POST /v1/blobs/{lowercase SHA-256 digest}/verify

200 {"digest":"…64 lowercase hex…","bytes":123456,"verified":true}
```

Sign an empty request body with `EMPTY_DIGEST`; a media playback grant cannot authorize verification. The worker opens a regular file without following symlinks, hashes its actual bytes and checks its descriptor and path identity again before returning. Size, inode, device, mtime and ctime must stay unchanged. Every request hashes again; it does not trust a previous receipt or the content-addressed filename. Verification does not rewrite or repair a file.

`GET /v1/status` advertises:

```text
storage.verification: {
  supported: true,
  maxConcurrent: 1,
  maxFileBytes: 17179869184,
  timeoutMs: 60000,
  active: 0
}
```

At most one verification runs per node, using a 256 KiB buffer and yielding between reads. The 16 GiB existing per-file bound still applies. New verification declines under node memory/CPU pressure. The request has a 60-second deadline; a helper should allow 65 seconds for transport and retry a busy or slow node later. A stalled kernel file read cannot be interrupted by JavaScript: the response still times out, while that one slot and its read lease stay occupied until the in-flight syscall returns. This prevents a backlog or a DELETE race. Disconnecting the caller cancels further work.

Failure responses never contain file paths or raw I/O errors:

| HTTP | Error                            | Meaning                                                                    |
| ---- | -------------------------------- | -------------------------------------------------------------------------- |
| 404  | `media_not_found`                | File absent; older workers also return an unsupported-route 404.           |
| 409  | `digest_mismatch`                | Persisted bytes differ from the digest.                                    |
| 409  | `blob_changed`                   | A replacement, truncation or metadata change occurred during verification. |
| 503  | `verification_busy`              | Another verification or resource pressure prevents admission.              |
| 504  | `verification_timeout`           | No complete proof was produced within the deadline.                        |
| 400  | `invalid_media` / `invalid_body` | Unsupported file/size or a nonempty verification body.                     |

Only HTTP 200 with `verified: true`, the requested digest and the expected byte count is a usable receipt. Missing capability, an unsupported route, a timeout, offline storage, corruption or mismatched fields means the helper must retain local bytes. A receipt describes the file when verified; it is not a promise against future disk failures. The helper remains responsible for archive placement, replica retention and its local-cache policy.

Read leases cover verification, served blob ranges and source media during playback preparation. A DELETE targeting an active reader returns HTTP 409 `blob_in_use`; retry after that reader ends. An idle media connection is closed after 30 seconds. Existing files are never deleted by verification. Other replicas and household devices are not involved in this endpoint.

The recording recovery catalog also preserves bounded original provenance: `originalCompatible` and `compatibilityRepaired` booleans, `originalPolicyVersion: 1`, and `originalProvenance` as `{kind:"camera",platform?,manufacturer?,model?}` or `{kind:"haus-encoder",profile:1}`. Labels are limited to 160 characters; unrecognized metadata is omitted. A legacy playback version alone never becomes a claim that the original is safe for immediate playback.
