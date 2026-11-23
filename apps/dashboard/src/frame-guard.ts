// The dashboard refuses to run inside a frame: a page that frames it could lay its own buttons
// over the dashboard's. The server's headers forbid framing too; this holds where something in
// between dropped them.

/** Whether this window is inside a frame. A cross-origin parent still compares safely. */
export function framed(view: { readonly top: unknown; readonly self: unknown } = window): boolean {
  try {
    return view.top !== view.self;
  } catch {
    return true;
  }
}
