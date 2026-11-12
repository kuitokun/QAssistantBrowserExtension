# Changelog

## 1.0.3 · November 11, 2026

- Pop-ups and panels are captured like scrolling by hand: a real screenshot of the whole screen at each scroll position, with the page behind exactly as it is. Without splitting, they appear one below the other; with splitting, each is its own image in Word.

## 1.0.2 · November 11, 2026

- Full-page captures scroll an open pop-up window, such as a Salesforce **New** record window, instead of the page behind it.
- New option, **Scroll the area under the mouse**, to choose which panel a full-page capture scrolls.
- When a panel or pop-up is scrolled, the image shows the whole tab with that area stretched in place, including the pop-up's title and buttons.

## 1.0.1 · November 9, 2026

- New icon: a document with QA and a check mark, with a simplified version for small sizes.
- Chrome Web Store images added in `assets/store`.

## 1.0.0 · November 8, 2026

First release.

**Capture**
- Capture the visible area, a full scrolling page, or the entire screen.
- **Taskbar on every capture** keeps the browser bar and the taskbar, with the date and time, on full-page and visible-area captures.
- Delay of 3, 5 or 10 seconds before a capture, counted down on the extension icon.
- Shortcuts: **Alt+Shift+Q** opens the menu, **Alt+Shift+F** captures the full page, **Alt+Shift+V** the visible area and **Alt+Shift+D** the entire screen.
- Full-page captures of apps that scroll inside a panel, such as Salesforce, chats and mail, show the header and bottom bar only once.

**Editing**
- Highlight, box, arrow, note and hide tools, with undo and redo.
- Hidden areas become permanent when you click **Done**.
- A title and notes for each step.

**Word document**
- Real headings, notes and pictures that you can keep editing.
- Long screenshots can be split **by screen**, like screenshots taken while scrolling, or to fit the Word page.
- Each part can start with the browser bar and end with the taskbar.

**Privacy and security**
- Everything stays in your browser, and nothing is sent over the internet.
- No site access, accounts or third-party code. Screen capture is optional and asked for only when you turn it on.
