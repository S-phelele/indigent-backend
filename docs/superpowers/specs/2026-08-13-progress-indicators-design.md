# Show progress that is actually true

Design agreed 13 August 2026. Not yet implemented.

## The problem

Nothing anywhere calls axios's `onUploadProgress`. There are five upload call
sites across the three clients and not one of them knows how many bytes have
gone:

| Client | Call site |
|---|---|
| Mobile | `src/services/upload.ts` → `uploadDocument()`, used by `DocumentSlots.tsx` |
| Applicant portal | `pages/Apply.jsx`, `pages/Documents.jsx` (two paths) |
| Admin portal | `pages/council/CaptureApplication.jsx` |

Mobile shows a bare `ActivityIndicator` in the document slot. The portals show
nothing beyond a disabled control. A household photographing an ID book produces
a file of a few megabytes; on a rural connection that is a long wait behind a
spinner that never moves, which is precisely where somebody taps again and
creates a duplicate.

Longer server-side work — submission, exports, geocoding — has the same gap for a
different reason: there is nothing to measure, but there are stages worth naming.

## Decisions

| Question | Decision |
|---|---|
| What the upload loader shows | Real byte progress, with cancel |
| Also covered | Application submission, OTP send and verify, admin exports, address search and geolocation |
| Motion | Restrained, honouring reduced-motion |

## The rule that governs all of it

**Never show a number that is not true.** A determinate bar is only used where
real bytes are being counted. Everything else gets a named stage or an honest
indeterminate state. A bar that creeps to 90% and waits is worse than a spinner,
because it teaches people that the number means nothing.

This follows the philosophy already written into `Skeleton.jsx`: skeletons for a
first load, because they say what is about to arrive; dim-and-keep for a refresh,
because replacing a table somebody is reading with grey bars is a downgrade. The
same instinct extends here.

## Uploads

Thread `onUploadProgress` and an `AbortController` through each upload helper, and
report `{ loaded, total, percent }` to the caller. Where `total` is unknown the
component falls back to indeterminate rather than inventing a denominator.

What the applicant sees:

- A determinate ring or bar carrying the true percentage.
- The file name and its size, so a 4 MB photo explains its own wait.
- **Cancel**, wired to `AbortController`. Someone stuck on a bad link must have an
  option other than closing the app.
- On completion the control **morphs into the supplied state** rather than
  disappearing and re-rendering — the slot is already the right shape.

Cancelling must leave nothing behind. The abort has to reach the server before a
partial file is committed, and `uploads/` should be checked after a cancelled
upload during testing.

## Processes with no byte count

Named stages, driven by where the client actually is, not by a timer.

- **Submission** — `Checking your documents → Submitting → Sending your reference`.
  These are real phases of `readiness()` then `submit()`, not decoration.
- **OTP send and verify** — including the auto-submit on the sixth digit, which
  today announces itself only as the plain text "Checking your code…".
- **Admin exports** — statistics workbooks and spreadsheet downloads, which take
  real time on a large register and currently give no feedback while the file is
  built.
- **Address search and device geolocation** — both routinely take several seconds
  with nothing on screen.

## Motion

Restrained. Progress rings, a gentle shimmer, a tick that draws itself.

Two constraints that are not negotiable, because of who uses this:

- **`prefers-reduced-motion` on web and the OS reduce-motion setting on mobile**
  drop every animation to a static state. The numbers stay.
- The existing `aria-busy`, `aria-live` and `sr-only` announcements are kept.
  They already exist in `Skeleton.jsx` and must not be lost in the rewrite.

These run on low-end Android handsets. Animation heavy enough to jank on the
phones our applicants actually own is a worse experience than no animation, and
the sober municipal tone of the rest of the UI is a better fit than something
playful.

## Shared primitives

One per client, not one per call site.

- Mobile: `src/components/Progress.tsx` — determinate ring, indeterminate state,
  staged label, cancel affordance.
- Portals: `src/components/ui/Progress.jsx`, alongside the existing `Skeleton.jsx`
  and following its conventions.

The two portals already duplicate `api.js`, `Skeleton.jsx` and `Modal.jsx`
between them. This adds one more duplicated file rather than introducing a shared
package — consistent with how the repo is currently organised, and a change worth
making deliberately rather than as a side effect of this work.

## Testing

Mostly manual; this is interface behaviour.

- Throttle to Slow 3G and upload a multi-megabyte file. The percentage must move
  and must correspond to bytes sent.
- Cancel mid-upload. The slot returns to empty, and `uploads/` gains no orphan.
- Turn on reduce-motion. Animation stops; progress figures remain; the screen
  reader still announces.
- Watch a percentage stall on a bad connection. It must stall at its true figure.

One unit test worth having: the progress helper's percentage calculation, given
`loaded` and `total`, including the case where `total` is absent.
