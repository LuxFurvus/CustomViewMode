# Custom View Mode

An extension for customizing how website pages appear in your browser. Hide unwanted blocks or select a single element to automatically fit it to the window.

## Installation

1. Open `chrome://extensions` in Google Chrome (version 106 or later).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `ReSizer` folder containing `manifest.json`.
5. Open a regular HTTP/HTTPS page. The extension can also run in tabs opened before installation.

After changing the source files, click the reload button on the extension's card and reload any open pages.

## Usage

1. Right-click the page and select **Start View Customization**. You can also click the extension icon and then **Customize page**.
2. A translucent panel appears in the bottom-right corner. Drag it by its header to move it.
3. Choose **Hide** or **Fit to window**. Hover over an element: an outline highlights the selected block. Left-click to select it. Links and buttons do not perform their usual actions while selection mode is active.
4. If needed, enable **All similar elements**: this updates the last action and immediately previews the result. The toggle is unavailable if there are no similar elements.
5. Choose a scope and click **Accept**. Clicking **Reject** or pressing **Esc** restores the state from before the current session.

**Ctrl+Z** (or **Cmd+Z**) and the **Undo step** button undo the entire last action. When editing the section path field, Ctrl+Z undoes text input as usual.

In the extension popup, you can temporarily disable all rules for a site, remove only auto-fit rules, or reset all site settings. The numbers of hiding and auto-fit rules are shown separately. Changes apply to tabs that are already open. Saving new rules re-enables the site. Navigating to another URL while customizing cancels the unsaved session.

## Auto-fit to window

1. Start customization and choose **Fit to window**.
2. Click the desired element. It stays on the page, and its visible area is enlarged or reduced while preserving its proportions. Chrome's own zoom level does not change; the primary use case is **100%** browser zoom.
3. If an image is inside a link, `<a><img …></a>`, select the image and then click **Select parent** to save a rule for the `<a>` element. The label and outline show the target. **Return to child** returns to the previous target in this chain.
4. Choose the current page, a section, or the entire site, and click **Accept**. You can save auto-fit alone without hiding any elements.

The extension saves the block's selector, not a fixed percentage. If a different image appears inside the same `<a>`, the size is recalculated. Auto-fit responds to image loading, content changes, DOM node replacement, and window resizing. The available area is based on the parent container's width and the window dimensions, with a 16 px margin around the window edges; ancestors that clip content further restrict this area.

Auto-fit scales the block's outer area. Its own scrolling and content clipping are preserved: the contents of an inner scrollable container are not fully expanded. The element is neither copied nor moved to another container. When auto-fit is first applied, the page and scrollable ancestors scroll to the target. Later recalculations do not bring the user back to the element after they scroll away.

Only one auto-fit target is active on a page. Selecting a new target during a session replaces the previous one; **Ctrl+Z** restores the previous step, including the scroll position. **Reject** restores the previous rules, styling, and scroll position. Saving within the same scope replaces the auto-fit target while preserving hiding rules. Saving only hiding rules does not remove a previously configured auto-fit rule.

If a rule matches multiple elements, auto-fit is paused and the panel displays a warning: select a more specific block. If the target has not appeared yet or has no dimensions, the extension waits for it. Hidden blocks and blocks inside hidden ancestors are not fitted.

## Scopes

| Scope | What it includes |
| --- | --- |
| Current page | The exact protocol, host, port, path, and query parameters. The `#…` fragment is ignored. |
| Site section | The specified path and its descendant paths on the same site. `/articles` includes `/articles/42`, but not `/articles-old`. Query parameters are ignored. |
| Entire site | All paths on the current `origin` (protocol, host, and port). Subdomains and HTTP/HTTPS are configured separately. |

The entire site is selected by default. For a section, the parent path is suggested; you can edit it, but the current page must belong to that section. For a single-level path such as `/articles`, the suggested section is `/articles`. The section option is unavailable on the home page. All matching hiding rules are combined. Auto-fit uses the following priority: **exact page → deepest matching section → entire site**. If the target of a higher-priority rule is missing, the extension waits for it without switching to another rule.

## How hiding works

The extension stores CSS selectors, not a copy of the page. Stable IDs, attributes, and classes are preferred. If the only way to distinguish an element is its position among siblings, the panel displays a warning. A single-element selection is unique on the current page; on another page, the rule looks for the corresponding element using the same attributes or position.

Hiding uses user-origin CSS with `display: none !important`. DOM nodes are preserved, and the space they occupy usually collapses. Dynamically added elements are also affected by saved rules. In group selection mode, the result and match count are visible before saving.

Significant changes to a site's layout may require configuring it again. The extension does not automatically recognize the purpose of blocks. Elements may sometimes appear briefly before local rules finish loading.

## Data, permissions, and limitations

- All rules are stored in `chrome.storage.local`. There are no servers, analytics, accounts, or synchronization. Uninstalling the extension deletes its data.
- The storage format has been updated to version 2. Existing version 1 hiding rules are migrated automatically, preserving scopes, identifiers, and site enabled states.
- Access to HTTP/HTTPS sites is required to apply rules automatically on subsequent visits. `contextMenus` adds the menu command, `scripting` applies CSS, `storage` stores rules, and `webNavigation` tracks SPA navigation.
- The first version selects elements in the main document. Content inside site iframes and Shadow DOM is not supported. The iframe itself and a web component's outer element can be hidden as blocks.
- Chrome's internal pages, the Chrome Web Store, local files, and the built-in PDF viewer are not supported. The popup displays a message for unsupported pages.
- Hash routes, such as `/#/article/42`, share the same **Current page** scope because the URL fragment is ignored.
- A single session is limited to 500 actions; the set of rules applied at once is limited to 5,000 selectors. Total storage is limited by Chrome's quota.
- Rules hide interface elements but do not block the site's network requests.
- Auto-fit does not remove fixed site panels or guarantee that the target remains visible beneath their overlays. Available space may be restricted by a clipping container. For elements without their own box (`display: contents`) and inner SVG elements, select a suitable parent. An outer SVG element, an image, an HTML block, or the iframe itself can be an auto-fit target.

## Development and testing

The extension files run without a build step. `core.js` contains URL and storage logic; `selectors.js` handles selector generation; `fit.js` implements reversible auto-fit and size observation; `background.js` handles privileged operations and sequential writes; `content.js` provides element selection and the panel; and `popup.*` manages site settings.

Tests require Node.js 20+ (it is not required to install or manually test the extension):

```powershell
npm test
```

The logic tests require no dependencies. For browser tests, install Playwright and its Chromium browser:

```powershell
npm install
npx playwright install chromium
npm run test:browser
```

Browser tests load the actual unpacked extension in a separate temporary profile, start a local HTTP server, and check selection, undo, grouping, saving, SPA navigation, new DOM nodes, multiple tabs, write failures, and browser restarts. Your user profile is not used. A screenshot of the interface is saved to `test-results/customization.png`.

If a compatible Chromium browser is already installed elsewhere, set the `CRM_CHROMIUM_PATH` environment variable to the absolute path of its executable. To use an existing Playwright browser cache, you can set `PLAYWRIGHT_BROWSERS_PATH`.

Manual acceptance checks: launch customization through Chrome's actual context menu, move the panel, select and undo, save and restart the browser, disable/reset rules in the popup, and verify normal page behavior after leaving customization mode. Publishing to the Chrome Web Store is not included in this delivery.

### Manual auto-fit checks

Automated tests were not run when this feature was added. The user performs these checks in Chrome:

| Scenario | Expected result |
| --- | --- |
| Reload the extension at `chrome://extensions`, reload the tab, and set Chrome zoom to 100% | The new mode appears; existing hiding rules continue to apply. |
| Select large, small, wide, and tall images | Proportions are preserved; large images shrink and small images grow to fit the available area. |
| Select an image inside `<a>`, move to its parent, and return to the child | The outline and label match the target; selecting the link does not open it. |
| Save a rule for `<a>`, then replace its image or wait for lazy loading | Auto-fit recalculates for the new content without requiring configuration again. |
| Resize the window | The outer block is recalculated based on the available width and height. |
| Fit a block containing text, mixed content, video, or internal scrolling | The contents scale with the block; the inner scrollable container is preserved. |
| After fitting, scroll the page away from the target, then wait for a content update | The extension recalculates the size without scrolling the page back to the target. |
| Select a different target, press Ctrl+Z, then click **Reject** | The previous target, original styling, and corresponding scroll positions are restored. |
| Save auto-fit, reload the page, and navigate to a similar page or SPA route | The appropriate rule is applied automatically. |
| Create different targets for the site, a nested section, and an exact page | Priority is: page, deepest matching section, site. |
| Replace the selected DOM node with another matching the same selector | The new target is picked up automatically. |
| Create a second match for the selector | Auto-fit pauses; the panel displays a warning. |
| Hide the target or its parent, then undo hiding | Auto-fit pauses while the block is hidden and resumes when it is restored. |
| Disable the site or remove only auto-fit rules through the popup | Scaling is removed in all open tabs; removing auto-fit alone preserves hiding rules. |
| Close and reopen Chrome | Scopes and targets are preserved; existing hiding rules are retained. |
