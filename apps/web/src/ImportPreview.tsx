import { useEffect, useRef, useState } from "react";
import {
  CatalogueError,
  fetchMeasurements,
  localeForHost,
  unitOptions,
  type Measurement,
} from "./catalogue";
import { IngredientForm } from "./IngredientForm";
import { IngredientPicker, type ChosenIngredient } from "./IngredientPicker";
import {
  ImportPreviewError,
  previewImport,
  SaveImportError,
  saveImport,
  type ImportPreview as Preview,
  type PreviewIngredient,
} from "./imports";
import {
  amountFlags,
  flagHint,
  initialChoice,
  lineNotes,
  lineStatus,
  saveRequest,
  type LineChoice,
  type LineStatus,
} from "./review";
import { navigate } from "./router";

type Request = { url: string; refresh: boolean };

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; preview: Preview }
  | { kind: "error"; error: unknown };

const fetchFailedReasons: Record<string, string> = {
  unreachable: "The site didn't respond. Check the address, or try later.",
  blocked: "The site refused our request.",
  challenged: "The site asked for a human check that we can't complete.",
  http_error: "The site answered with an error instead of the page.",
};

const flagLabels: Record<string, string> = {
  unit_unmatched: "Unit not recognised",
  mixed_amount: "Mixed amount",
  range: "Range",
  no_quantity: "No quantity",
  unit_ambiguous: "Unit ambiguous",
};

const extractionLabels: Record<string, string> = {
  "json-ld": "Structured data (JSON-LD)",
  microdata: "Microdata",
};

const strategyLabels: Record<string, string> = {
  http: "Plain HTTP",
  impit: "Browser-like fetch (impit)",
};

function describeError(error: unknown): { message: string; detail?: string } {
  if (!(error instanceof ImportPreviewError)) {
    return { message: "Something went wrong importing that page." };
  }
  switch (error.code) {
    case "invalid_url":
      return { message: "That doesn't look like a web address" };
    case "no_recipe_found":
      return { message: "We couldn't find a recipe on that page" };
    case "fetch_failed":
      return {
        message: "We couldn't fetch that page",
        ...(error.reason && {
          detail: fetchFailedReasons[error.reason] ?? `Reason: ${error.reason}`,
        }),
      };
    case "import_not_permitted":
      return { message: "This site does not permit importing its recipes" };
    case "unauthenticated":
      return { message: "Your session has ended. Sign in again to import." };
    case null:
      return {
        message: `Can't reach the API: ${error.message}. Check the api container is running (docker compose ps), then try again.`,
      };
    default:
      return {
        message: "Something went wrong importing that page.",
        detail: `Error: ${error.code}`,
      };
  }
}

function minutes(value: number | null): string {
  if (value === null) return "Not given";
  const h = Math.floor(value / 60);
  const m = value % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// Consecutive lines that share a section, so each section gets one heading.
function groupBySection(lines: PreviewIngredient[]) {
  const groups: { section: string | null; lines: PreviewIngredient[] }[] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (last && last.section === line.section) last.lines.push(line);
    else groups.push({ section: line.section, lines: [line] });
  }
  return groups;
}

type Units =
  | { kind: "loading" }
  | { kind: "loaded"; units: Measurement[] }
  | { kind: "error"; error: unknown };

type Saving =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "failed"; message: string; detail?: string };

function describeSaveError(
  error: unknown,
  lines: number,
): { message: string; detail?: string } {
  if (!(error instanceof SaveImportError)) {
    return {
      message:
        "We couldn't save the recipe. Your changes are still here, so try again.",
    };
  }
  const these = lines === 1 ? "1 line" : `${lines} lines`;
  switch (error.code) {
    case "unresolved_lines":
      return {
        message: `We couldn't save the recipe: ${these} name an ingredient or unit that is no longer in the catalogue. Choose them again, then save.`,
      };
    case "invalid_lines":
      return {
        message: `We couldn't save the recipe: ${these} have an amount or notes we couldn't store. Fix them, then save.`,
      };
    case "invalid_steps":
      return {
        message: `We couldn't save the recipe: the page's step ${error.positions.join(", ")} couldn't be stored. Fetch the page again, then save.`,
      };
    case "unauthenticated":
      return { message: "Your session has ended. Sign in again to save." };
    case null:
      return {
        message: `Can't reach the API: ${error.message}. Check the api container is running (docker compose ps), then try again.`,
      };
    default:
      return {
        message:
          "We couldn't save the recipe. Your changes are still here, so try again.",
        detail: `Error: ${error.code}`,
      };
  }
}

// Scrolls to a line and focuses the control that needs the cook.
function goTo(target: HTMLElement | null, focus: HTMLElement | null) {
  if (!target) return;
  const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)")
    .matches;
  target.scrollIntoView?.({ behavior: smooth ? "smooth" : "auto" });
  focus?.focus({ preventScroll: true });
}

function lineId(position: number) {
  return `line-${position}`;
}

function Draft({
  preview,
  units,
  locale,
  onRetryUnits,
}: {
  preview: Preview;
  units: Units;
  locale: string;
  onRetryUnits: () => void;
}) {
  const { recipe } = preview;
  const [choices, setChoices] = useState<Map<number, LineChoice>>(
    () =>
      new Map(
        recipe.ingredients.map((line) => [line.position, initialChoice(line)]),
      ),
  );
  const [saving, setSaving] = useState<Saving>({ kind: "idle" });
  const saveAlert = useRef<HTMLDivElement>(null);
  const busy = saving.kind === "saving";

  useEffect(() => {
    if (saving.kind === "failed") saveAlert.current?.focus();
  }, [saving]);

  const unitIds = new Set(
    units.kind === "loaded" ? units.units.map((unit) => unit.id) : [],
  );
  const pageLocale = localeForHost(new URL(preview.sourceUrl).hostname);
  const lines = recipe.ingredients.map((line) => {
    const choice = choices.get(line.position) ?? initialChoice(line);
    return { line, choice, status: lineStatus(choice, unitIds) };
  });
  const unresolved = lines.filter(({ status }) => !status.ready);
  const canSave = units.kind === "loaded" && unresolved.length === 0;

  function change(position: number, update: Partial<LineChoice>) {
    setChoices((current) => {
      const next = new Map(current);
      const line = recipe.ingredients.find((l) => l.position === position);
      const before = current.get(position) ?? (line && initialChoice(line));
      if (before) next.set(position, { ...before, ...update, rejected: null });
      return next;
    });
  }

  function save() {
    if (!canSave || busy) return;
    setSaving({ kind: "saving" });
    saveImport(saveRequest(preview, choices)).then(
      (saved) =>
        navigate(`/recipes/${saved.id}`, {
          state: { saved: true, alreadyImported: saved.alreadyImported },
        }),
      (err: unknown) => {
        if (!(err instanceof SaveImportError) || err.code === null) {
          console.error("saving the import failed", preview.sourceUrl, err);
        }
        let rejected = 0;
        if (
          err instanceof SaveImportError &&
          (err.code === "unresolved_lines" || err.code === "invalid_lines")
        ) {
          const reason =
            err.code === "unresolved_lines" ? "unresolved" : "invalid";
          const positions = new Set(err.positions);
          rejected = positions.size;
          setChoices((current) => {
            const next = new Map(current);
            for (const [position, choice] of current) {
              if (positions.has(position)) {
                next.set(position, { ...choice, rejected: reason });
              }
            }
            return next;
          });
        }
        setSaving({ kind: "failed", ...describeSaveError(err, rejected) });
      },
    );
  }

  function focusLine(position: number, status: LineStatus) {
    const prefix = `${lineId(position)}-`;
    const control = status.needsIngredient
      ? `${prefix}ingredient`
      : status.badQuantity
        ? `${prefix}quantity`
        : status.needsUnit
          ? `${prefix}unit`
          : `${prefix}ingredient`;
    goTo(
      document.getElementById(lineId(position)),
      document.getElementById(control),
    );
  }

  const total = recipe.ingredients.length;

  return (
    <article aria-labelledby="draft-title" className="draft">
      {preview.ingredientMatching.status !== "ok" && (
        <p className="health" data-tone="warn">
          {preview.ingredientMatching.message}
        </p>
      )}
      {preview.warnings.map((warning) => (
        <p key={warning} className="notice">
          {warning === "multiple_recipes_found"
            ? "This page had more than one recipe; we imported the first."
            : `Warning: ${warning}`}
        </p>
      ))}

      <h3 id="draft-title">{recipe.title}</h3>
      <dl className="facts">
        <dt>Servings</dt>
        <dd>{recipe.servings ?? "Not given"}</dd>
        <dt>Prep time</dt>
        <dd>{minutes(recipe.prepMinutes)}</dd>
        <dt>Cook time</dt>
        <dd>{minutes(recipe.cookMinutes)}</dd>
      </dl>

      {total > 0 && units.kind === "loaded" && (
        <div
          role="status"
          className="health review-summary"
          data-tone={unresolved.length > 0 ? "warn" : "good"}
        >
          {unresolved.length > 0 ? (
            <p>
              {unresolved.length} of {total} ingredient lines need you before
              you can save.{" "}
              <a
                href="#unresolved"
                onClick={(event) => {
                  event.preventDefault();
                  const section = document.getElementById("save");
                  goTo(section, section);
                }}
              >
                Go to the list
              </a>
            </p>
          ) : (
            <p>
              All {total} ingredient lines are ready.{" "}
              <a
                href="#save"
                onClick={(event) => {
                  event.preventDefault();
                  goTo(
                    document.getElementById("save"),
                    document.getElementById("save-recipe"),
                  );
                }}
              >
                Go to Save
              </a>
            </p>
          )}
        </div>
      )}

      <h4>Ingredients</h4>
      {total === 0 ? (
        <p>The page lists no ingredients.</p>
      ) : units.kind === "loading" ? (
        <p role="status" className="health" data-tone="pending">
          Loading the units…
        </p>
      ) : units.kind === "error" ? (
        <>
          <div role="alert" className="health" data-tone="bad">
            <p>
              We couldn't load the list of units, so the lines can't be checked
              yet.
            </p>
            <p className="detail">{describeUnitsError(units.error)}</p>
          </div>
          <button type="button" onClick={onRetryUnits}>
            Try again
          </button>
        </>
      ) : (
        <>
          <p className="hint">
            Check each line and change anything that's wrong. Lines marked Needs
            an ingredient or Check the amount must be fixed before you can save.
          </p>
          {groupBySection(recipe.ingredients).map((group) => (
            <div key={group.lines[0]?.position} className="review-group">
              {group.section !== null && (
                <h5 className="section">{group.section}</h5>
              )}
              <ul className="review-lines">
                {group.lines.map((line) => {
                  const entry = lines.find(
                    (l) => l.line.position === line.position,
                  )!;
                  return (
                    <ReviewLine
                      key={line.position}
                      line={line}
                      choice={entry.choice}
                      status={entry.status}
                      units={units.units}
                      locale={locale}
                      pageLocale={pageLocale}
                      disabled={busy}
                      onChange={(update) => change(line.position, update)}
                    />
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}

      <h4>Steps</h4>
      {recipe.steps.length === 0 ? (
        <p>The page lists no steps.</p>
      ) : (
        <ol>
          {recipe.steps.map((step) => (
            <li key={step.position}>{step.text}</li>
          ))}
        </ol>
      )}

      <h4>Tags</h4>
      {recipe.tags.length === 0 ? (
        <p>No tags.</p>
      ) : (
        <ul className="tags">
          {recipe.tags.map((tag) => (
            <li key={tag} className="badge">
              {tag}
            </li>
          ))}
        </ul>
      )}

      <h4>How it was imported</h4>
      <dl className="facts">
        <dt>Source</dt>
        <dd>
          <a href={preview.sourceUrl}>{preview.sourceUrl}</a>
        </dd>
        <dt>Extraction</dt>
        <dd>{extractionLabels[preview.extraction] ?? preview.extraction}</dd>
        <dt>Fetched with</dt>
        <dd>
          {strategyLabels[preview.fetchStrategy] ?? preview.fetchStrategy}
        </dd>
        <dt>Fetched at</dt>
        <dd>
          <time dateTime={preview.fetchedAt}>
            {new Date(preview.fetchedAt).toLocaleString()}
          </time>
        </dd>
      </dl>

      <section
        id="save"
        tabIndex={-1}
        className="save-section"
        aria-labelledby="save-heading"
      >
        <h4 id="save-heading">
          {unresolved.length > 0 ? "Before you can save" : "Save"}
        </h4>
        {unresolved.length > 0 && units.kind === "loaded" && (
          <div id="unresolved">
            <p>
              Fix{" "}
              {unresolved.length === 1
                ? "this line"
                : `these ${unresolved.length} lines`}
              :
            </p>
            <ul className="unresolved-list">
              {unresolved.map(({ line, status }) => (
                <li key={line.position}>
                  <a
                    href={`#${lineId(line.position)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      focusLine(line.position, status);
                    }}
                  >
                    {line.rawText}
                  </a>{" "}
                  — {status.label}
                </li>
              ))}
            </ul>
          </div>
        )}
        {saving.kind === "failed" && (
          <div
            ref={saveAlert}
            role="alert"
            tabIndex={-1}
            className="health"
            data-tone="bad"
          >
            <p>{saving.message}</p>
            {saving.detail && <p className="detail">{saving.detail}</p>}
          </div>
        )}
        <button
          type="button"
          id="save-recipe"
          disabled={!canSave}
          aria-disabled={busy || undefined}
          aria-describedby="save-hint"
          onClick={save}
        >
          {busy ? "Saving…" : "Save recipe"}
        </button>
        {busy ? (
          <p id="save-hint" role="status" className="hint">
            Saving the recipe…
          </p>
        ) : (
          !canSave && (
            <p id="save-hint" className="hint">
              You can save once every line is fixed.
            </p>
          )
        )}
      </section>
    </article>
  );
}

function describeUnitsError(error: unknown): string {
  if (error instanceof CatalogueError && error.code !== null) {
    return error.code === "unauthenticated"
      ? "Your session has ended. Sign in again to import."
      : `Error: ${error.code}`;
  }
  return `Can't reach the API: ${error instanceof Error ? error.message : "an unexpected error"}. Check the api container is running (docker compose ps), then try again.`;
}

function ReviewLine({
  line,
  choice,
  status,
  units,
  locale,
  pageLocale,
  disabled,
  onChange,
}: {
  line: PreviewIngredient;
  choice: LineChoice;
  status: LineStatus;
  units: Measurement[];
  locale: string;
  pageLocale: string;
  disabled: boolean;
  onChange: (update: Partial<LineChoice>) => void;
}) {
  const id = lineId(line.position);
  const [creating, setCreating] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const flags = amountFlags(line);
  const showFlags = flags.length > 0 && status.needsUnit;
  const otherFlags = line.flags.filter(
    (flag) => !flags.includes(flag) && flag !== "ingredient_unmatched",
  );
  const notes = status.needsUnit ? null : lineNotes(line, choice);
  const hintId = `${id}-hint`;
  const forLine = (
    <>
      {" "}
      <span className="visually-hidden">for {line.rawText}</span>
    </>
  );

  function choose(ingredient: ChosenIngredient) {
    setCreated(null);
    onChange({ ingredient });
  }

  function closeForm() {
    setCreating(null);
    document.getElementById(`${id}-ingredient`)?.focus();
  }

  return (
    <li id={id} className="review-line" data-tone={status.tone}>
      <div className="line-head">
        <p className="line-source">
          <span className="hint">From the page</span>
          <span className="line-raw">{line.rawText}</span>
        </p>
        <p className="line-status" data-tone={status.tone}>
          <span aria-hidden="true" className="line-status-icon">
            {status.tone === "ready" ? "✓" : status.tone === "bad" ? "!" : "⚠"}
          </span>
          {status.label}
        </p>
      </div>

      <div className="line-fields">
        <div className="field quantity-field">
          <label htmlFor={`${id}-quantity`}>Quantity{forLine}</label>
          <input
            id={`${id}-quantity`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={choice.quantity}
            readOnly={disabled}
            aria-invalid={status.badQuantity || undefined}
            aria-describedby={
              status.badQuantity ? `${id}-quantity-error` : undefined
            }
            onChange={(event) => onChange({ quantity: event.target.value })}
          />
        </div>
        <div className="field unit-field">
          <label htmlFor={`${id}-unit`}>Unit{forLine}</label>
          <select
            id={`${id}-unit`}
            value={status.needsUnit ? "" : String(choice.unit)}
            disabled={disabled}
            data-needs={status.needsUnit || undefined}
            aria-describedby={showFlags ? hintId : undefined}
            onChange={(event) => {
              const { value } = event.target;
              onChange({ unit: value === "none" ? "none" : Number(value) });
            }}
          >
            <option value="" disabled>
              Choose a unit…
            </option>
            <option value="none">
              No unit (keep the page’s text in notes)
            </option>
            {unitOptions(units, locale).map((group) => (
              <optgroup key={group.type} label={group.label}>
                {group.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field ingredient-field">
          <label htmlFor={`${id}-ingredient`}>Ingredient{forLine}</label>
          <IngredientPicker
            inputId={`${id}-ingredient`}
            value={choice.ingredient}
            defaultQuery={line.ingredientText}
            candidates={line.candidates}
            disabled={disabled}
            describedBy={choice.rejected ? `${id}-rejected` : undefined}
            onChoose={choose}
            onCreate={(name) => {
              setCreated(null);
              setCreating(name);
            }}
          />
        </div>
      </div>

      {status.badQuantity && (
        <p id={`${id}-quantity-error`} className="field-error">
          Enter a number, like 1.5.
        </p>
      )}
      {choice.rejected && (
        <p id={`${id}-rejected`} className="field-error">
          {choice.rejected === "unresolved"
            ? "Its ingredient or unit is no longer in the catalogue. Choose them again."
            : "We couldn't store its amount or notes. Check the quantity."}
        </p>
      )}
      {showFlags && (
        <div id={hintId} className="line-hints">
          {flags.map((flag) => (
            <p key={flag}>
              <span className="badge">{flagLabels[flag] ?? flag}</span>
              {flagHint(line, flag)}
            </p>
          ))}
        </div>
      )}
      {otherFlags.length > 0 && (
        <p className="line-hints">
          {otherFlags.map((flag) => (
            <span key={flag} className="badge">
              {flagLabels[flag] ?? flag}
            </span>
          ))}
        </p>
      )}
      {line.prepNotes !== null && (
        <p className="line-notes">Prep notes: {line.prepNotes}</p>
      )}
      {notes !== null && <p className="line-notes">Notes: {notes}</p>}
      {created && (
        <p role="status" className="hint">
          Created {created}.
        </p>
      )}

      {creating !== null && (
        <IngredientForm
          heading={`New ingredient for “${line.rawText}”`}
          headingLevel={5}
          initialNames={[{ name: creating, locale: pageLocale }]}
          defaultLocale={pageLocale}
          onCreated={(ingredient) => {
            const name =
              ingredient.names.find(
                (n) => n.locale === pageLocale && n.isCanonical,
              )?.name ??
              ingredient.names[0]?.name ??
              creating;
            onChange({ ingredient: { id: ingredient.id, name } });
            closeForm();
            setCreated(name);
          }}
          onUseExisting={(ingredient) => {
            choose(ingredient);
            closeForm();
          }}
          onCancel={closeForm}
        />
      )}
    </li>
  );
}

// `locale` is the signed-in user's, for unit names and their order.
export function ImportPreview({ locale }: { locale: string }) {
  const [url, setUrl] = useState("");
  const [request, setRequest] = useState<Request | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [units, setUnits] = useState<Units>({ kind: "loading" });
  const [unitsAttempt, setUnitsAttempt] = useState(0);

  // Asked for alongside the preview, so the lines can be checked as soon as
  // it arrives.
  useEffect(() => {
    const controller = new AbortController();
    fetchMeasurements(controller.signal).then(
      (list) => setUnits({ kind: "loaded", units: list }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        console.error("loading the units failed", err);
        setUnits({ kind: "error", error: err });
      },
    );
    return () => controller.abort();
  }, [unitsAttempt]);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    previewImport(request.url, request.refresh, controller.signal).then(
      (preview) => setState({ kind: "loaded", preview }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (!(err instanceof ImportPreviewError) || err.code === null) {
          console.error("import preview failed", request.url, err);
        }
        setState({ kind: "error", error: err });
      },
    );
    return () => controller.abort();
  }, [request]);

  const loading = state.kind === "loading";

  function submit(refresh: boolean, target: string) {
    setState({ kind: "loading" });
    setRequest({ url: target, refresh });
  }

  return (
    <section aria-labelledby="import-heading">
      <h2 id="import-heading">Import from URL</h2>
      <form
        className="import-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit(false, url.trim());
        }}
      >
        <label htmlFor="import-url">Recipe page address</label>
        <div className="import-row">
          <input
            id="import-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" disabled={loading}>
            Import
          </button>
        </div>
      </form>

      {loading && (
        <p role="status" className="health" data-tone="pending">
          Fetching the recipe…
        </p>
      )}

      {state.kind === "error" && <ErrorMessage error={state.error} />}

      {request && !loading && (
        <button type="button" onClick={() => submit(true, request.url)}>
          Fetch again
        </button>
      )}

      {state.kind === "loaded" && (
        // A new preview starts a new review.
        <Draft
          key={`${state.preview.sourceUrl} ${state.preview.fetchedAt}`}
          preview={state.preview}
          units={units}
          locale={locale}
          onRetryUnits={() => {
            setUnits({ kind: "loading" });
            setUnitsAttempt((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

function ErrorMessage({ error }: { error: unknown }) {
  const { message, detail } = describeError(error);
  return (
    <div role="alert" className="health" data-tone="bad">
      <p>{message}</p>
      {detail && <p className="detail">{detail}</p>}
    </div>
  );
}
