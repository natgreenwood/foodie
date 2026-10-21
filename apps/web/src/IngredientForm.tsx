import { useEffect, useId, useRef, useState } from "react";
import {
  CATALOGUE_LOCALES,
  CatalogueError,
  createIngredient,
  localeLabel,
  type Ingredient,
} from "./catalogue";

// Creates a catalogue ingredient (NATG-210). Standalone: nothing in here
// knows about imports, so the catalogue page (NATG-344) uses it as is.

// The api's caps (MAX_NAME_CHARS and MAX_CATEGORY_CHARS in
// apps/api/src/routes/ingredients.ts).
const MAX_NAME_CHARS = 100;
const MAX_CATEGORY_CHARS = 100;

interface Row {
  key: number;
  name: string;
  locale: string;
}

// Row keys, unique across every form on the page.
let nextRowKey = 0;

function newRow(name: string, locale: string): Row {
  return { key: nextRowKey++, name, locale };
}

type RowError =
  | { kind: "blank" }
  | { kind: "repeated" }
  | { kind: "taken"; existing: { id: number; name: string } };

type Failure = { message: string; detail?: string };

function describeFailure(error: unknown): Failure {
  if (!(error instanceof CatalogueError)) {
    return { message: "We couldn't create the ingredient. Try again." };
  }
  switch (error.code) {
    case null:
      return {
        message:
          "We couldn't create the ingredient. Check your connection and try again.",
      };
    case "unauthenticated":
      return {
        message: "Your session has ended. Sign in again to add an ingredient.",
      };
    case "invalid_request":
      return {
        message: "We couldn't create the ingredient.",
        detail: error.message,
      };
    case "name_taken":
      return {
        message: "A name you entered is already in the catalogue.",
        detail: error.message,
      };
    default:
      return {
        message: "We couldn't create the ingredient. Try again.",
        detail: `Error: ${error.code}`,
      };
  }
}

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface IngredientFormProps {
  heading: string;
  headingLevel?: 2 | 3 | 4 | 5;
  // The rows the form opens with; one empty row in `defaultLocale` if none.
  initialNames?: { name: string; locale: string }[];
  // The language a new row starts in.
  defaultLocale: string;
  onCreated: (ingredient: Ingredient) => void;
  onCancel: () => void;
  // The cook chose the ingredient that already has a name they typed.
  onUseExisting: (ingredient: { id: number; name: string }) => void;
}

export function IngredientForm({
  heading,
  headingLevel = 3,
  initialNames,
  defaultLocale,
  onCreated,
  onCancel,
  onUseExisting,
}: IngredientFormProps) {
  const id = useId();
  const [rows, setRows] = useState<Row[]>(() =>
    initialNames && initialNames.length > 0
      ? initialNames.map((n) => newRow(n.name, n.locale))
      : [newRow("", defaultLocale)],
  );
  const [category, setCategory] = useState("");
  const [rowErrors, setRowErrors] = useState<Map<number, RowError>>(
    () => new Map(),
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const nameInputs = useRef(new Map<number, HTMLInputElement>());
  const alert = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);

  // Focus starts on the first name.
  useEffect(() => {
    const first = rows[0];
    if (first) nameInputs.current.get(first.key)?.focus();
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusRow.current === null) return;
    nameInputs.current.get(focusRow.current)?.focus();
    focusRow.current = null;
  });

  useEffect(() => {
    if (failure) alert.current?.focus();
  }, [failure]);

  // Offered even if not a catalogue locale, so a row's locale stays
  // selectable.
  const languages = { ...CATALOGUE_LOCALES };
  for (const row of rows) {
    if (!(row.locale in languages)) languages[row.locale] = row.locale;
  }

  function update(key: number, change: Partial<Row>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...change } : row)),
    );
    setRowErrors((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }

  function validate(): Map<number, RowError> {
    const errors = new Map<number, RowError>();
    rows.forEach((row, i) => {
      if (row.name.trim() === "") errors.set(row.key, { kind: "blank" });
      else if (
        rows
          .slice(0, i)
          .some((r) => r.locale === row.locale && sameName(r.name, row.name))
      ) {
        errors.set(row.key, { kind: "repeated" });
      }
    });
    return errors;
  }

  function submit() {
    const errors = validate();
    setRowErrors(errors);
    setFailure(null);
    const firstInvalid = rows.find((row) => errors.has(row.key));
    if (firstInvalid) {
      nameInputs.current.get(firstInvalid.key)?.focus();
      return;
    }
    setSaving(true);
    createIngredient({
      names: rows.map((row) => ({ name: row.name.trim(), locale: row.locale })),
      category: category.trim() === "" ? null : category.trim(),
    }).then(onCreated, (err: unknown) => {
      setSaving(false);
      const taken = err instanceof CatalogueError ? err.taken : undefined;
      const row =
        taken &&
        rows.find(
          (r) =>
            r.locale.toLowerCase() === taken.name.locale.toLowerCase() &&
            sameName(r.name, taken.name.name),
        );
      if (taken && row) {
        setRowErrors(
          new Map([
            [
              row.key,
              {
                kind: "taken",
                existing: {
                  id: taken.ingredient.id,
                  name: taken.ingredient.name ?? taken.name.name,
                },
              },
            ],
          ]),
        );
        nameInputs.current.get(row.key)?.focus();
        return;
      }
      if (!(err instanceof CatalogueError) || err.code === null) {
        console.error("creating an ingredient failed", err);
      }
      setFailure(describeFailure(err));
    });
  }

  const Heading = `h${headingLevel}` as const;

  return (
    <form
      className="ingredient-form"
      aria-labelledby={`${id}-heading`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <Heading id={`${id}-heading`}>{heading}</Heading>

      {failure && (
        <div
          ref={alert}
          role="alert"
          tabIndex={-1}
          className="health"
          data-tone="bad"
        >
          <p>{failure.message}</p>
          {failure.detail && <p className="detail">{failure.detail}</p>}
        </div>
      )}

      <fieldset disabled={saving}>
        <legend>Names</legend>
        <p className="hint" id={`${id}-names-hint`}>
          Add each name the ingredient goes by. The first name in a language is
          the one recipes show.
        </p>
        {rows.map((row, i) => {
          const error = rowErrors.get(row.key);
          const inputId = `${id}-name-${row.key}`;
          const errorId = `${inputId}-error`;
          return (
            <div key={row.key} className="name-row">
              <div className="field name-field">
                <label htmlFor={inputId}>Name {i + 1}</label>
                <input
                  id={inputId}
                  ref={(el) => {
                    if (el) nameInputs.current.set(row.key, el);
                    else nameInputs.current.delete(row.key);
                  }}
                  type="text"
                  value={row.name}
                  maxLength={MAX_NAME_CHARS}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={
                    error ? errorId : i === 0 ? `${id}-names-hint` : undefined
                  }
                  onChange={(event) =>
                    update(row.key, { name: event.target.value })
                  }
                />
                {error && (
                  <p id={errorId} className="field-error">
                    {error.kind === "blank" &&
                      "Enter a name, or remove this row."}
                    {error.kind === "repeated" &&
                      `This name is already listed for ${localeLabel(row.locale)}.`}
                    {error.kind === "taken" &&
                      `“${row.name.trim()}” is already in the catalogue for ${localeLabel(row.locale)}.`}
                  </p>
                )}
                {error?.kind === "taken" && (
                  <button
                    type="button"
                    className="use-existing"
                    onClick={() => onUseExisting(error.existing)}
                  >
                    Use {error.existing.name}
                  </button>
                )}
              </div>
              <div className="field">
                <label htmlFor={`${inputId}-locale`}>Language</label>
                <select
                  id={`${inputId}-locale`}
                  value={row.locale}
                  onChange={(event) =>
                    update(row.key, { locale: event.target.value })
                  }
                >
                  {Object.entries(languages).map(([tag, label]) => (
                    <option key={tag} value={tag}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="remove-name"
                aria-label={`Remove name ${i + 1}`}
                disabled={rows.length === 1}
                onClick={() => {
                  setRows((current) =>
                    current.filter((r) => r.key !== row.key),
                  );
                  const neighbour = rows[i + 1] ?? rows[i - 1];
                  if (neighbour) focusRow.current = neighbour.key;
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => {
            const row = newRow("", defaultLocale);
            setRows((current) => [...current, row]);
            focusRow.current = row.key;
          }}
        >
          <span aria-hidden="true">+ </span>Add another name
        </button>
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-category`}>Category (optional)</label>
        <input
          id={`${id}-category`}
          type="text"
          value={category}
          maxLength={MAX_CATEGORY_CHARS}
          disabled={saving}
          aria-describedby={`${id}-category-hint`}
          onChange={(event) => setCategory(event.target.value)}
        />
        <p className="hint" id={`${id}-category-hint`}>
          For example: sauces and condiments.
        </p>
      </div>

      <div className="actions">
        <button type="submit" disabled={saving}>
          {saving ? "Creating…" : "Create ingredient"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {saving && (
        <p role="status" className="hint">
          Creating the ingredient…
        </p>
      )}
    </form>
  );
}
