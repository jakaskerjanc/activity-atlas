// The fixed top strip of an overlay panel: title, a muted subtitle, and the panel's own
// collapse/close control aligned with the title. On the phone's bottom sheet a grab
// handle sits above it and the whole strip toggles the sheet.

import type { ReactNode } from "react";
import { FS, iconButton } from "./theme";
import { CloseIcon } from "./icons";
import type { ActivityLink } from "../format";

interface Props {
  title: string;
  /** Rich title (e.g. with the arrow icon); `title` stays the plain text for tooltips. */
  titleNode?: ReactNode;
  /** The activity's pages on Garmin Connect / Strava, as letter badges after the title. */
  links?: ActivityLink[];
  subtitle?: ReactNode;
  /** The collapse/close button. */
  action?: { label: string; icon: ReactNode; onClick: () => void; expanded?: boolean; controls?: string };
  /** The phone's sheet: a grab handle, and the whole strip toggles. */
  sheet?: boolean;
  /** An explicit way out (back to all activities), shown as a × beside the collapse control. */
  close?: { label: string; onClick: () => void };
}

export function PanelHeader({ title, titleNode, links = [], subtitle, action, sheet, close }: Props) {
  return (
    <div
      onClick={sheet ? action?.onClick : undefined}
      style={{ flex: "0 0 auto", cursor: sheet ? "pointer" : undefined }}
    >
      {sheet && <span className="sheet-handle" aria-hidden="true" />}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: sheet ? "8px 12px 12px 18px" : "14px 12px 12px 18px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
          <h2 style={titleStyle}>
            <span style={ellipsis} title={title}>
              {titleNode ?? title}
            </span>
            {links.length > 0 && (
              <span style={badgeRow}>
                {links.map((l) => (
                  <a
                    key={l.url}
                    className="source-badge"
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={l.label}
                    title={l.label}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {l.short}
                  </a>
                ))}
              </span>
            )}
          </h2>
          {subtitle && <div style={subStyle}>{subtitle}</div>}
        </div>
        {close && (
          <button
            type="button"
            className="ctl"
            onClick={(e) => {
              e.stopPropagation();
              close.onClick();
            }}
            aria-label={close.label}
            title={`${close.label} (Esc)`}
            style={iconButton}
          >
            <CloseIcon />
          </button>
        )}
        {action && (
          <button
            type="button"
            className="ctl"
            onClick={(e) => {
              e.stopPropagation();
              action.onClick();
            }}
            aria-label={action.label}
            title={action.label}
            aria-expanded={action.expanded}
            aria-controls={action.controls}
            style={iconButton}
          >
            {action.icon}
          </button>
        )}
      </div>
    </div>
  );
}

const titleStyle = {
  margin: 0,
  fontSize: FS.lg,
  fontWeight: 650,
  lineHeight: 1.3,
  color: "var(--text-strong)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
} as const;

const badgeRow = { display: "flex", gap: 4, flex: "0 0 auto" } as const;

const ellipsis = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
} as const;

const subStyle = {
  marginTop: 2,
  fontSize: FS.sm,
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;
