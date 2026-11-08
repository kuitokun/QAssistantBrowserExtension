# QAssistant

QAssistant is a browser extension for Chrome and Brave that turns screenshots into an editable Word test document. Capture a page, mark it up, add a title and notes, then download a `.docx` with every step.

It runs only in your browser and sends nothing over the internet.

## What it does

- **Captures** the visible area, a full scrolling page, or the entire screen, including in apps that scroll inside a panel, such as Salesforce.
- **Keeps the browser bar and the taskbar** with the date and time, when you turn that on.
- **Splits long pages by screen**, so one click gives the same images as scrolling and taking a screenshot each time.
- **Marks up screenshots** with highlights, boxes, arrows, notes, and blacked-out private details.
- **Waits before capturing** for 3, 5 or 10 seconds, so you can open a menu or switch to another window.
- **Builds a Word document** with real headings, notes and pictures that you can keep editing.

## Install

1. Open [Releases](../../releases/latest) and download the `QAssistant-Extension` zip, not **Source code**.
2. Unzip it to a permanent folder, because the browser keeps loading QAssistant from there.
3. Open `chrome://extensions` or `brave://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and choose the unzipped folder.
5. Pin QAssistant to the toolbar.

If you downloaded **Source code** or this whole project instead, choose its `extension` folder in step 4. The right folder is always the one with `manifest.json` directly inside.

To update, replace the files in that same folder, then click the reload icon on QAssistant in the extensions page. Your screenshots stay.

## Learn more

- [How it works](docs/HOW-IT-WORKS.md)
- [What changed in each version](CHANGELOG.md)
- [Security review for IT teams](docs/SECURITY-REVIEW.md)
- [Privacy policy](PRIVACY.md)
- [Report a security problem](SECURITY.md)

## License

Copyright (c) 2026 Kuito Azek SG. You may use QAssistant, including at work, but you may not modify or redistribute it. See [LICENSE](LICENSE).
