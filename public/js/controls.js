import { el } from "./api.js";

/** Petits contrôles partagés par les éditeurs (incrustations, textes, sous-titres). */

export function panel(title) {
  const box = el("div", { class: "ctrl-panel" });
  if (title) box.append(el("div", { class: "panel-title", text: title }));
  return box;
}

export function slider(label, { min, max, step = 1, value, unit = "", hint = "", onChange, format }) {
  const input = el("input", { type: "range", min, max, step, value });
  const output = el("span", { class: "val", text: format ? format(value) : `${value}${unit}` });
  if (hint) input.title = hint;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    output.textContent = format ? format(v) : `${v}${unit}`;
    onChange?.(v);
  });
  const node = el("div", { class: "ctrl" }, [el("span", { class: "ctrl-label", text: label }), input, output]);
  return { node, input, set: (v) => { input.value = v; output.textContent = format ? format(v) : `${v}${unit}`; }, value: () => Number(input.value) };
}

export function toggle(label, value, onChange, hint = "") {
  const input = el("input", { type: "checkbox", ...(value ? { checked: true } : {}) });
  if (hint) input.title = hint;
  input.addEventListener("change", () => onChange?.(input.checked));
  const node = el("label", { class: "ctrl toggle", title: hint }, [input, el("span", { text: label })]);
  return { node, input, value: () => input.checked };
}

export function selectField(label, options, value, onChange, hint = "") {
  const select = el("select", { title: hint }, options.map((option) => el("option", { value: option.value, text: option.label })));
  select.value = value;
  select.addEventListener("change", () => onChange?.(select.value));
  const node = el("div", { class: "ctrl select" }, [el("span", { class: "ctrl-label", text: label }), select]);
  return { node, select, value: () => select.value };
}

export function colorField(label, value, onChange) {
  const input = el("input", { type: "color", value: value || "#ffffff" });
  input.addEventListener("input", () => onChange?.(input.value));
  const node = el("div", { class: "ctrl color" }, [el("span", { class: "ctrl-label", text: label }), input]);
  return { node, input };
}

export function chipRow(items, current, onPick) {
  const row = el("div", { class: "chips" });
  for (const item of items) {
    const chip = el("button", {
      class: `chip${item.id === current ? " active" : ""}`,
      text: `${item.icon ? `${item.icon} ` : ""}${item.label}`,
      title: item.hint || item.label,
      onclick: () => {
        for (const other of row.children) other.classList.remove("active");
        chip.classList.add("active");
        onPick(item.id);
      },
    });
    row.append(chip);
  }
  return row;
}

export function field(label, value, onChange, { type = "text", placeholder = "", hint = "", rows } = {}) {
  const input = rows
    ? el("textarea", { rows, placeholder, title: hint })
    : el("input", { type, value, placeholder, title: hint });
  if (!rows) input.value = value ?? "";
  else input.value = value ?? "";
  input.addEventListener("input", () => onChange?.(input.value));
  const node = el("label", { class: "ctrl field" }, [el("span", { class: "ctrl-label", text: label }), input]);
  return { node, input, value: () => input.value };
}
