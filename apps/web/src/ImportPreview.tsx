import { useEffect, useState } from "react";
import {
  ImportPreviewError,
  previewImport,
  type ImportPreview as Preview,
  type PreviewIngredient,
} from "./imports";

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

function Draft({ preview }: { preview: Preview }) {
  const { recipe } = preview;
  return (
    <article aria-labelledby="draft-title" className="draft">
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

      <h4>Ingredients</h4>
      {recipe.ingredients.length === 0 ? (
        <p>The page lists no ingredients.</p>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Ingredients"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Quantity</th>
                <th scope="col">Unit</th>
                <th scope="col">Ingredient</th>
                <th scope="col">Prep notes</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            {groupBySection(recipe.ingredients).map((group) => (
              <tbody key={group.lines[0]?.position}>
                {group.section !== null && (
                  <tr>
                    <th colSpan={5} scope="rowgroup" className="section">
                      {group.section}
                    </th>
                  </tr>
                )}
                {group.lines.map((line) => (
                  <tr key={line.position}>
                    <td>{line.quantityText ?? "—"}</td>
                    <td>{line.unitText ?? "—"}</td>
                    <td>
                      {line.ingredientText}
                      {line.notes !== null && (
                        <span className="line-notes">Note: {line.notes}</span>
                      )}
                    </td>
                    <td>{line.prepNotes ?? "—"}</td>
                    <td>
                      {line.flags.map((flag) => (
                        <span key={flag} className="badge">
                          {flagLabels[flag] ?? flag}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
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
    </article>
  );
}

export function ImportPreview() {
  const [url, setUrl] = useState("");
  const [request, setRequest] = useState<Request | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

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

      {state.kind === "loaded" && <Draft preview={state.preview} />}
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
