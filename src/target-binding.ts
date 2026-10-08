import type { FieldKind } from "./protocol.js";

const BINDING_ATTRIBUTES = ["id", "name", "type", "form", "autocomplete", "contenteditable"] as const;

export interface FieldTargetBinding {
  target: HTMLElement;
  documentRef: Document;
  origin: string;
  root: Document | ShadowRoot;
  parent: Node | null;
  ancestry: ReadonlyArray<Node>;
  form: HTMLFormElement | null;
  fieldKind: FieldKind;
  attributes: ReadonlyArray<string | null>;
}

function composedAncestry(target: HTMLElement): ReadonlyArray<Node> {
  const ancestry: Node[] = [];
  let current: Node | null = target;
  while (current) {
    ancestry.push(current);
    current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null);
  }
  return ancestry;
}

function deepestActiveElement(root: Document | ShadowRoot): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export function isEditableField(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return ["text", "email", "password", "search", "tel", "url"].includes(element.type) && !element.disabled && !element.readOnly;
  }
  return element.isContentEditable;
}

export function fieldKindFor(element: HTMLElement): FieldKind {
  if (element instanceof HTMLInputElement) return element.type === "password" ? "password" : "short-text";
  return "long-text";
}

export function bindFieldTarget(target: HTMLElement): FieldTargetBinding {
  const root = target.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) throw new Error("unsupported target root");
  const form = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.form : null;
  return {
    target,
    documentRef: document,
    origin: location.origin,
    root,
    parent: target.parentNode,
    ancestry: composedAncestry(target),
    form,
    fieldKind: fieldKindFor(target),
    attributes: BINDING_ATTRIBUTES.map((name) => target.getAttribute(name))
  };
}

export function assertFieldTargetBinding(binding: FieldTargetBinding): void {
  const { target } = binding;
  const form = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.form : null;
  const attributes = BINDING_ATTRIBUTES.map((name) => target.getAttribute(name));
  const ancestry = composedAncestry(target);
  if (
    document !== binding.documentRef || location.origin !== binding.origin ||
    target.ownerDocument !== binding.documentRef || !isEditableField(target) ||
    target.getRootNode() !== binding.root || target.parentNode !== binding.parent ||
    ancestry.length !== binding.ancestry.length || ancestry.some((node, index) => node !== binding.ancestry[index]) ||
    deepestActiveElement(binding.documentRef) !== target || fieldKindFor(target) !== binding.fieldKind ||
    form !== binding.form || attributes.some((value, index) => value !== binding.attributes[index])
  ) throw new Error("target context changed");
}

export function injectBoundValue(
  binding: FieldTargetBinding,
  plaintext: Uint8Array,
  revalidate: () => void
): void {
  const { target } = binding;
  const value = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: value });
  if (!target.dispatchEvent(before)) throw new Error("insertion refused");

  // The destination page controls beforeinput handlers. Revalidate after those
  // handlers return and immediately before the native value write so they cannot
  // redirect the retained element, its focus, or its field/form identity.
  revalidate();
  assertFieldTargetBinding(binding);

  if (target instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
  } else if (target instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(target, value);
  } else {
    target.textContent = value;
  }
  target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}
