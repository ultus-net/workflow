import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { WebConfigOption } from "../web-config-options.js";
import { withCurrentChoice } from "./presenters.js";

type ConfigChoice = NonNullable<WebConfigOption["choices"]>[number];

export function ConfigSelect({ option, setOption, labelledBy }: {
  readonly option: WebConfigOption;
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly labelledBy?: string | undefined;
}) {
  const current = String(option.currentValue);
  return (
    <select
      value={current}
      onChange={(event) => setOption(option.id, event.target.value)}
      aria-label={labelledBy === undefined ? option.name : undefined}
      aria-labelledby={labelledBy}
      title={option.description}
    >
      {withCurrentChoice(option).map((choice) => (
        <option value={choice.value} key={choice.value} title={choice.description}>{choice.name}</option>
      ))}
    </select>
  );
}

/** Long lists get a searchable combobox; short lists keep the native select. */
const COMBOBOX_MIN_CHOICES = 8;

/** Per-option favourite choices, persisted locally (presentation-only; never sent to the agent). */
function useFavourites(optionId: string): readonly [readonly string[], (value: string) => void] {
  const key = `workflow.config-favourites.${optionId}`;
  const [favourites, setFavourites] = useState<readonly string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  });
  const toggle = useCallback((value: string): void => {
    setFavourites((previous) => {
      const next = previous.includes(value) ? previous.filter((entry) => entry !== value) : [...previous, value];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private browsing or quota: favourites stay session-local.
      }
      return next;
    });
  }, [key]);
  return [favourites, toggle];
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M1 1l4 4 4-4" />
    </svg>
  );
}

export function ConfigCombobox({ option, setOption, labelledBy }: {
  readonly option: WebConfigOption;
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly labelledBy?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  // Fixed-viewport coordinates for the portalled popover; computed on open so
  // the list escapes any ancestor `overflow: hidden` (composer chips row).
  const [popPos, setPopPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [favourites, toggleFavourite] = useFavourites(option.id);

  const current = String(option.currentValue);
  const all = withCurrentChoice(option);
  const currentName = all.find((choice) => choice.value === current)?.name ?? current;
  const needle = query.trim().toLowerCase();
  const filtered = needle === ""
    ? all
    : all.filter((choice) => choice.name.toLowerCase().includes(needle) || choice.value.toLowerCase().includes(needle));
  const favouriteMatches = filtered.filter((choice) => favourites.includes(choice.value));
  const otherMatches = filtered.filter((choice) => !favourites.includes(choice.value));
  const selectable = [...favouriteMatches, ...otherMatches];
  const showGroups = favouriteMatches.length > 0 && otherMatches.length > 0;

  const closeList = useCallback((focusButton: boolean): void => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);
  const choose = useCallback((value: string): void => {
    setOption(option.id, value);
    closeList(true);
  }, [option.id, setOption, closeList]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      const insideButton = rootRef.current?.contains(target) === true;
      const insidePop = popRef.current?.contains(target) === true;
      if (!insideButton && !insidePop) closeList(false);
    };
    // A scroll that moves the anchor detaches the fixed popover; close it. A
    // scroll *inside* the popover (the operator scrolling the list) must not.
    const onScroll = (event: Event): void => {
      if (popRef.current?.contains(event.target as Node) === true) return;
      closeList(false);
    };
    const onResize = (): void => closeList(false);
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, closeList]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const openList = (): void => {
    setQuery("");
    // Recompute the reset list from the unfiltered choices: a stale query
    // must not leak into the reopened active index.
    const nextSelectable = [
      ...all.filter((choice) => favourites.includes(choice.value)),
      ...all.filter((choice) => !favourites.includes(choice.value)),
    ];
    setActiveIndex(Math.max(0, nextSelectable.findIndex((choice) => choice.value === current)));
    // Anchor the portalled popover in viewport coordinates: open toward the
    // side with more room (up from the composer, down when high in a dialog),
    // and clamp horizontally so the list never overflows the right edge.
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect !== undefined) {
      const gap = 6;
      const maxPopWidth = Math.min(352, window.innerWidth * 0.9);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - maxPopWidth - 8));
      const openUp = rect.top >= window.innerHeight - rect.bottom;
      setPopPos(openUp
        ? { left, bottom: window.innerHeight - rect.top + gap }
        : { left, top: rect.bottom + gap });
    }
    setOpen(true);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, selectable.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, selectable.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = selectable[activeIndex];
      if (choice !== undefined) choose(choice.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      // This Escape closes the combobox only; the global shortcut handler
      // must not read it as "cancel the running turn".
      event.stopPropagation();
      closeList(true);
    }
  };

  const listId = `config-list-${option.id}`;
  const renderChoice = (choice: ConfigChoice, index: number) => {
    const starred = favourites.includes(choice.value);
    return (
      <li
        key={choice.value}
        id={`config-opt-${option.id}-${index}`}
        role="option"
        aria-selected={choice.value === current}
        className={`config-combobox-option ${index === activeIndex ? "config-combobox-active" : ""}`}
        onMouseDown={(event) => { event.preventDefault(); choose(choice.value); }}
        onMouseEnter={() => setActiveIndex(index)}
      >
        <button
          type="button"
          className={`config-star ${starred ? "config-starred" : ""}`}
          aria-label={starred ? `Remove ${choice.name} from favourites` : `Add ${choice.name} to favourites`}
          aria-pressed={starred}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.stopPropagation(); toggleFavourite(choice.value); }}
        >
          {starred ? "★" : "☆"}
        </button>
        <span className="config-combobox-name" title={choice.description}>{choice.name}</span>
        {choice.value === current && <span className="config-combobox-check" aria-hidden="true">✓</span>}
      </li>
    );
  };

  return (
    <span className="config-combobox" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="config-combobox-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={labelledBy === undefined ? option.name : undefined}
        aria-labelledby={labelledBy}
        title={option.description}
        onClick={() => (open ? closeList(false) : openList())}
      >
        <span className="config-combobox-value">{currentName}</span>
        <ChevronIcon />
      </button>
      {open && popPos !== null && createPortal(
        <span
          ref={popRef}
          className="config-combobox-pop"
          style={{ left: popPos.left, ...(popPos.top !== undefined ? { top: popPos.top } : { bottom: popPos.bottom }) }}
          onBlur={(event) => {
            // Tab flows through the search input and star toggles; once focus
            // leaves the popover entirely, close it.
            if (event.currentTarget.contains(event.relatedTarget) === false) closeList(false);
          }}
        >
          <input
            ref={inputRef}
            className="config-combobox-search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={onSearchKeyDown}
            placeholder={`Search ${option.name.toLowerCase()}…`}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={selectable[activeIndex] === undefined ? undefined : `config-opt-${option.id}-${activeIndex}`}
            aria-autocomplete="list"
            aria-label={`Search ${option.name}`}
          />
          <ul className="config-combobox-list" role="listbox" id={listId} aria-label={option.name} ref={listRef}>
            {selectable.length === 0 && <li className="config-combobox-empty">no matches</li>}
            {showGroups && <li className="config-combobox-group" role="presentation">Favourites</li>}
            {favouriteMatches.map((choice, index) => renderChoice(choice, index))}
            {showGroups && <li className="config-combobox-group" role="presentation">All</li>}
            {otherMatches.map((choice, index) => renderChoice(choice, favouriteMatches.length + index))}
          </ul>
        </span>,
        document.body,
      )}
    </span>
  );
}

/** Select for short lists, searchable combobox (favourites + search) for long ones. */
export function ConfigField({ option, setOption, labelledBy }: {
  readonly option: WebConfigOption;
  readonly setOption: (id: string, value: string | boolean) => void;
  readonly labelledBy?: string | undefined;
}) {
  return (option.choices?.length ?? 0) >= COMBOBOX_MIN_CHOICES
    ? <ConfigCombobox option={option} setOption={setOption} labelledBy={labelledBy} />
    : <ConfigSelect option={option} setOption={setOption} labelledBy={labelledBy} />;
}
