// An activity's page on Garmin Connect or Strava, as a quiet button: the provider's
// name and the external-link mark, the full "View on …" for screen readers and the
// tooltip. The map panel's footer and the Activities preview both use it.

import type { CSSProperties } from "react";
import { ExternalIcon } from "./icons";
import { FS, secondaryButton } from "./theme";
import type { ActivityLink } from "../format";

/** The size an activity's action buttons share (this one, and Show on map beside it). */
export const actionSize: CSSProperties = { height: 30, padding: "0 10px", gap: 6, fontSize: FS.sm };

export function ProviderLink({ link, style }: { link: ActivityLink; style?: CSSProperties }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="ctl"
      aria-label={link.label}
      title={link.label}
      style={{ ...secondaryButton, ...actionSize, textDecoration: "none", ...style }}
    >
      {link.label.replace(/^View on /, "")}
      <ExternalIcon />
    </a>
  );
}
