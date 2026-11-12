# How QAssistant works

Each capture becomes one step in the same document, and it saves automatically.

1. Go to the page you want to record and click the QAssistant icon.
2. Choose a capture.
3. Mark up the image, then add a title and notes.
4. Click **Done, back to page** and repeat on the next page.
5. Click **Go to download**, name the document, and reorder or edit steps if needed.
6. Click **Download .docx**. The file goes to your normal downloads location.

In Word, titles are headings, notes are normal text and screenshots are normal pictures. **New document** clears the current steps, so download first if you need them.

## Captures

| Capture | Shortcut | What you get |
| --- | --- | --- |
| Open QAssistant | Alt+Shift+Q | The QAssistant menu, without clicking the icon |
| Capture full page | Alt+Shift+F | The whole page, even the part you have to scroll to |
| Capture visible area | Alt+Shift+V | Only what the page shows now |
| Capture entire screen | Alt+Shift+D | The whole screen, with the taskbar and clock |

If a shortcut doesn't work, another extension may already use it. Click **Change shortcuts** in the QAssistant menu, or open `chrome://extensions/shortcuts`, to pick your own.

Hover over or tab to any small **?** to see what an option does.

## Delay before capture

Choose **3**, **5** or **10 seconds** under **Delay before capture** in the menu. The menu closes, and the countdown shows on the extension icon, so you have time to open a dropdown or hover over something. The delay also applies to the shortcuts. Set it back to **None** for instant captures.

## Include the browser bar, taskbar and clock

This is optional and off by default. It uses your browser's screen sharing.

1. In the menu, tick **Taskbar on every capture**.
2. Click **Turn on screen capture**, then **Allow**.
3. Capture again and choose your screen in the browser's window.
4. Click **Hide** on the sharing bar so it stays out of your screenshots.

With it ticked, full-page and visible-area captures and their shortcuts keep the browser bar and the taskbar. A visible-area capture then saves the whole screen. Maximize the browser for the cleanest full-page image.

The browser bar and taskbar are taken when the capture starts, so every part of a long screenshot shows that same time. Your browser shows that sharing is on. It stops when you click **Stop**, or after 10 minutes without a capture.

## Capture a whole page as screen-by-screen images

One click gives you the same images as scrolling down and taking a screenshot each time.

1. Tick **Taskbar on every capture** in the menu, if you want the browser bar and clock.
2. Click **Capture full page**.
3. On the document page, tick **Split long screenshots** and choose **by screen**.
4. Leave **Browser bar and taskbar on every part** ticked.
5. Click **Download .docx**.

You only set these options once. Untick **Split long screenshots** to get the whole page as one image instead.

| Split choice | Each part | Best for |
| --- | --- | --- |
| by screen | Exactly one screen, like screenshots taken while scrolling | Matching what you saw; the last part shows the bottom of the page |
| to fit the Word page | As tall as a Word page allows | Fewer, taller parts |

By screen usually fits two parts on each Word page. The last part lines up with the bottom of the page, so some content can appear twice. With **to fit the Word page**, cuts fall in gaps between content where possible. If something has to be cut, the next part starts above it, so it appears whole there.

## Apps and other windows

- **Pop-up windows:** If a pop-up is open, such as a Salesforce **New** record window, **Capture full page** scrolls inside the pop-up, not the page behind it. It takes a real screenshot of the whole screen at each scroll position, like scrolling by hand. With **Split long screenshots** ticked, each screenshot is its own image in Word; otherwise they appear one below the other.
- **Salesforce, Outlook on the web and other apps:** They scroll inside a panel. **Capture full page** scrolls the largest scrolling area and takes a screenshot at each position, the same way as for pop-ups.
- **Choosing the area:** To scroll a different area, such as a related list or side panel, tick **Scroll the area under the mouse** in the menu. Point at the area and use **Alt+Shift+F**, or set a delay and move the mouse there during the countdown. If the mouse isn't over a scrolling area, QAssistant chooses as usual.
- **Outlook desktop and other programs:** Set a delay, click **Capture entire screen**, and switch to the program before the countdown ends. Only an entire-screen capture can see other programs, and shortcuts only work while the browser is in front. The step shows the address of the browser tab you started from, which you can hide by unticking **Show page address and time**.

## Editor tools

| Tool | Key | Use |
| --- | --- | --- |
| Select | V | Move, resize or delete an item |
| Highlight | H | Mark an area with color |
| Box | B | Outline an area |
| Arrow | A | Point at something |
| Note | T | Add text on the image |
| Hide | R | Black out private data |

Undo with Ctrl+Z and redo with Ctrl+Y. Double-click a note to change its text. **Hide** can't be undone after you click **Done** or **Open document**.

## Limits and troubleshooting

| Problem | What to do |
| --- | --- |
| The page isn't allowed | Browser pages such as `chrome://` can't be captured. On a normal site, click the icon again. |
| The clock isn't in the image | Turn on screen capture and tick **Taskbar on every capture**. |
| Only one part has the browser bar or taskbar | Make sure **Browser bar and taskbar on every part** is ticked, and that **Taskbar on every capture** was ticked when you captured it. |
| A sharing bar is in the image | Click **Hide** on the bar, then capture again. |
| A bar or reply box repeats down the image | Use **Capture visible area** for that part. |
| Part of a page looks wrong | Use **Capture visible area** for that part. |
| A very long page is cut off | Capture the rest separately. One image stops at about 30,000 pixels. |
| A long image looks small in Word | Tick **Split long screenshots** before downloading. |
