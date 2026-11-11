// ShowWindowToggle.jsx — the "Show browser window" checkbox of every place that launches a DevTools
// browser (the DevTools tab and the E2E check dialog). Browsers launch headless; ticking it asks the
// launch for a real, visible window (`headed: true`). Its state is the caller's, one launch at a time.
export function ShowWindowToggle({ checked, onChange }) {
  return (
    <label className="show-window-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      Show browser window
    </label>
  );
}
