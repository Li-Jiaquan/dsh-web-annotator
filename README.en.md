# DSH Web Annotator

[简体中文](README.md)

Annotate a webpage inside a DSH NEXT conversation. Select an element, draw a box, or highlight text, then add comments and a numbered screenshot to your conversation draft.

## Install

Requires DSH NEXT 2.0.11-next or later. The desktop screenshot workflow was tested with 2.0.21-next.

1. Clone the repository or download and extract the ZIP.

   ```bash
   git clone https://github.com/Li-Jiaquan/dsh-web-annotator.git
   ```

2. In a DSH conversation, ask the agent to run `plugin_manager` with the following arguments. Replace the example path with the absolute path to your local checkout.

   ```json
   {
     "action": "install_bundle",
     "target": "C:/Projects/dsh-web-annotator"
   }
   ```

3. Quit and reopen DSH NEXT.
4. In a conversation, click **Annotate** in the header or open **Web Annotator** in the right sidebar or conversation view.

## Use

1. Enter a URL and press **Enter**. For a local development server, try `http://localhost:3000`.
2. Turn on annotation mode. Click an element, hold **Shift** and drag to mark a region, or drag to select text.
3. Click a numbered marker to write, edit, or delete its comment. Hold **Space** in annotation mode to interact with the page temporarily.
4. Click **Write to chat**. Review the appended text and optional `screenshot-page.png` in the composer, then send it when ready.

Screenshot attachments are enabled by default. DSH NEXT can capture the visible webpage directly. Offscreen annotations and environments without native capture use local rendering. Turn off **Screenshots** for a text-only draft.

## Manage the bundle

Use `plugin_manager` with the same absolute directory path as the installation target. Run `set_bundle` with `enabled: true` to re-enable the bundle or `remove_bundle` to uninstall it. Restart DSH NEXT after uninstalling or changing `index.js`.

## Compatibility

Use public pages or local development sites. Pages requiring an existing login session may be unavailable. POST forms, hardcoded absolute requests in page scripts, and nested document base URLs have mirror limitations.

## License

[MIT](LICENSE). The bundled html2canvas distribution has its own [MIT notice](vendor/html2canvas.LICENSE).
