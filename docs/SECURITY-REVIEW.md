# QAssistant security review

This document is for teams deciding whether to allow QAssistant 1.0.0. It's written by the project and isn't an independent audit. The source code is public so you can verify it.

**Summary:** QAssistant is a Manifest V3 extension with no server, accounts, third-party code or site access. Its pages block network connections with a content security policy.

## Permissions

| Permission | Required | Why | What it can reach |
| --- | --- | --- | --- |
| `activeTab` | Yes | Captures the tab when the user clicks the icon or a shortcut | Only that tab, only after that action |
| `scripting` | Yes | Scrolls the page during a full-page capture | Only a tab allowed by `activeTab` |
| `storage` | Yes | Saves a setting and the latest error message | Extension storage only |
| `desktopCapture` | No, optional | Includes the browser bar, taskbar and clock in captures | Asks the user first, then opens the browser's screen picker |

There are no host permissions, content scripts, web-accessible resources or background access to pages. Keyboard shortcuts are declared with the standard `commands` key and count as a click on the extension.

## Data handling

| Data | Where it stays | How long |
| --- | --- | --- |
| Screenshots, titles, notes and marks | Extension IndexedDB on the device | Until deleted, replaced by a new document, or the extension is removed |
| Page address | With each step, without query string or fragment | Same as above |
| Word document | The browser's normal download location | Controlled by the user |

Hidden areas are permanently burned into the stored image when the user clicks **Done** or **Open document**. Until then, the original image remains in local storage so the edit can be undone. Stored data isn't separately encrypted, so it relies on the device's own disk encryption and access controls.

## Technical controls

- **Network:** The extension pages use `default-src 'none'`, and `connect-src` is limited to the extension itself and local `blob:` and `data:` URLs.
- **Code:** There's no remote code, `eval`, inline script or third-party dependency.
- **Page changes:** During a full-page capture, QAssistant temporarily scrolls the page and hides fixed bars and floating boxes, then restores them. It never changes page data or submits anything.
- **Screen capture:** Screen sharing needs the optional permission, the browser's picker and a visible sharing indicator. One frame is taken per capture. Sharing ends when the user stops it, closes its window, or after 10 minutes without a capture.
- **Automated check:** `scripts/check-security.js` fails if permissions, network code or the content security policy change.

## What was tested

Version 1.0.0 was tested in Chromium on Linux. Tests confirmed the installed permissions, blocked network requests from the extension page and service worker, query-string removal, permanent redaction, and the optional permission prompt. It hasn't had third-party penetration testing or testing on managed corporate Windows devices.

## Risks to consider

- **Screenshots can contain sensitive data.** That includes other windows when screen capture is used.
- **Word files are ordinary files.** They need the same handling rules as any test evidence.
- **Developer mode may be blocked.** Managed browsers may need a store listing or an allowlisted extension ID.
- **Policies can block screen sharing.** QAssistant can still capture tabs without it.

## Administrator controls

Administrators can allow or block QAssistant by extension ID with `ExtensionSettings`, and can restrict screen sharing with browser policies such as `ScreenCaptureAllowed`.
