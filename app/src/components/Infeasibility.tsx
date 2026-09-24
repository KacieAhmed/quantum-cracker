import { SCOPE_NOTE } from "../constants";

/** The standing honesty note, required wherever results or estimates show. */
export function Infeasibility() {
  return <p className="scope-note">{SCOPE_NOTE}</p>;
}
