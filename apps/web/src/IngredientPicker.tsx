import { useEffect, useId, useState, type KeyboardEvent } from "react";
import {
  CatalogueError,
  localeLabel,
  searchIngredients,
  type IngredientHit,
} from "./catalogue";
import type { IngredientCandidate } from "./imports";

// An ARIA 1.2 combobox over the catalogue: the line's suggestions, then a
// fuzzy search of every ingredient, then "Create". Picking an option
// chooses it; Esc, Tab or leaving the field closes it and puts back what
// was chosen before.

export const MAX_SUGGESTIONS = 8;
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 250;

export interface ChosenIngredient {
  id: number;
  name: string;
}

type Search =
  | { kind: "idle" }
  | { kind: "searching"; q: string }
  | { kind: "done"; q: string; hits: IngredientHit[] }
  | { kind: "failed"; q: string };

type Option =
  | { kind: "ingredient"; id: number; name: string; locale: string }
  | { kind: "create" };

export function IngredientPicker({
  inputId,
  value,
  defaultQuery,
  candidates,
  describedBy,
  disabled,
  onChoose,
  onCreate,
}: {
  inputId: string;
  value: ChosenIngredient | null;
  // Searched for when nothing is typed: the line's ingredient text.
  defaultQuery: string;
  candidates: IngredientCandidate[];
  describedBy?: string | undefined;
  disabled?: boolean;
  onChoose: (ingredient: ChosenIngredient) => void;
  onCreate: (name: string) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // What the cook has typed since the field was last closed; null shows
  // the chosen ingredient.
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [search, setSearch] = useState<Search>({ kind: "idle" });

  const q = typed?.trim() || defaultQuery.trim();
  const searchable = q.length >= SEARCH_MIN_CHARS;

  useEffect(() => {
    if (!open || !searchable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearch({ kind: "searching", q });
      searchIngredients(q, controller.signal).then(
        (hits) => setSearch({ kind: "done", q, hits }),
        (err: unknown) => {
          if (controller.signal.aborted) return;
          if (!(err instanceof CatalogueError) || err.code === null) {
            console.error("ingredient search failed", q, err);
          }
          setSearch({ kind: "failed", q });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, q, searchable]);

  const suggested = candidates.slice(0, MAX_SUGGESTIONS);
  const suggestedIds = new Set(suggested.map((c) => c.ingredientId));
  // Results for an earlier q are not shown as this q's.
  const current = searchable && "q" in search && search.q === q ? search : null;
  const matches =
    current?.kind === "done"
      ? current.hits.filter((hit) => !suggestedIds.has(hit.id))
      : [];

  const options: Option[] = [
    ...suggested.map((c): Option => ({
      kind: "ingredient",
      id: c.ingredientId,
      name: c.name,
      locale: c.locale,
    })),
    ...matches.map((hit): Option => ({ kind: "ingredient", ...hit })),
    { kind: "create" },
  ];
  const optionId = (i: number) => `${listId}-option-${i}`;

  function close() {
    setOpen(false);
    setTyped(null);
    setActive(-1);
  }

  function pick(option: Option) {
    close();
    if (option.kind === "create") onCreate(q);
    else onChoose({ id: option.id, name: option.name });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) setOpen(true);
        else if (!event.altKey) setActive((i) => (i + 1) % options.length);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (open) {
          setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
        }
        return;
      case "Enter": {
        const option = open ? options[active] : undefined;
        if (option) {
          event.preventDefault();
          pick(option);
        }
        return;
      }
      case "Escape":
        if (open || typed !== null) {
          event.preventDefault();
          close();
        }
        return;
      case "Tab":
        close();
        return;
    }
  }

  const counts =
    `${suggested.length} ${suggested.length === 1 ? "suggestion" : "suggestions"}` +
    (current?.kind === "done"
      ? `, ${matches.length} ${matches.length === 1 ? "match" : "matches"}`
      : "");

  return (
    <div className="combobox">
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && active >= 0 ? optionId(active) : undefined
        }
        aria-describedby={describedBy}
        autoComplete="off"
        placeholder="Choose or search…"
        disabled={disabled}
        value={typed ?? value?.name ?? ""}
        onChange={(event) => {
          setTyped(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Ingredients"
        className="listbox"
        hidden={!open}
      >
        {suggested.length > 0 && (
          <li role="group" aria-labelledby={`${listId}-suggested`}>
            <span
              id={`${listId}-suggested`}
              role="presentation"
              className="group-label"
            >
              Suggested for this line
            </span>
            <ul role="none">
              {suggested.map((c, i) => (
                <OptionItem
                  key={c.ingredientId}
                  id={optionId(i)}
                  active={active === i}
                  onPick={() => pick(options[i]!)}
                >
                  {c.name}
                  <span className="option-detail">{localeLabel(c.locale)}</span>
                </OptionItem>
              ))}
            </ul>
          </li>
        )}
        {searchable && (
          <li role="group" aria-labelledby={`${listId}-matches`}>
            <span
              id={`${listId}-matches`}
              role="presentation"
              className="group-label"
            >
              All ingredients matching “{q}”
            </span>
            <ul role="none">
              {current?.kind === "failed" ? (
                <li role="none" className="listbox-status">
                  Search failed. Close and try again.
                </li>
              ) : current?.kind === "done" ? (
                matches.length === 0 ? (
                  <li role="none" className="listbox-status">
                    No results
                  </li>
                ) : (
                  matches.map((hit, j) => {
                    const i = suggested.length + j;
                    return (
                      <OptionItem
                        key={hit.id}
                        id={optionId(i)}
                        active={active === i}
                        onPick={() => pick(options[i]!)}
                      >
                        {hit.name}
                        <span className="option-detail">
                          {localeLabel(hit.locale)}
                        </span>
                      </OptionItem>
                    );
                  })
                )
              ) : (
                <li role="none" className="listbox-status">
                  Searching…
                </li>
              )}
            </ul>
          </li>
        )}
        <li role="none" className="listbox-separator" />
        <OptionItem
          id={optionId(options.length - 1)}
          active={active === options.length - 1}
          onPick={() => pick({ kind: "create" })}
          className="create-option"
        >
          <span aria-hidden="true">+ </span>
          {q === "" ? "Create a new ingredient…" : `Create “${q}”…`}
        </OptionItem>
      </ul>
      <span role="status" className="visually-hidden">
        {open ? counts : ""}
      </span>
    </div>
  );
}

function OptionItem({
  id,
  active,
  onPick,
  className,
  children,
}: {
  id: string;
  active: boolean;
  onPick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      className={className}
      // Keeps focus in the input, so its blur does not close the list first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      {children}
    </li>
  );
}
