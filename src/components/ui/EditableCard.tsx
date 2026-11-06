"use client";

import { createContext, useContext, useState } from "react";
import { iconButtonCls, PencilIcon } from "./icons";

/**
 * A card with its title and a pencil in the top-right corner. The pencil swaps the read-only body (`children`) for
 * the `editor`; an editor inside closes the card's edit mode with `useEditableCard().close()`.
 */
const Ctx = createContext<{ close: () => void } | null>(null);
export const useEditableCard = () => useContext(Ctx);

export function EditableCard({
  title,
  editLabel,
  editTestId,
  canEdit,
  editor,
  children,
  testId,
}: {
  title: string;
  editLabel: string;
  editTestId?: string;
  canEdit: boolean;
  editor?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section
      className="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-line bg-surface p-5"
      aria-label={title}
      data-testid={testId}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="m-0 text-base font-semibold">{title}</h2>
        {canEdit && editor && !editing && (
          <button
            type="button"
            className={iconButtonCls}
            aria-label={editLabel}
            title={editLabel}
            data-testid={editTestId}
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </button>
        )}
      </div>
      {editing ? <Ctx.Provider value={{ close: () => setEditing(false) }}>{editor}</Ctx.Provider> : children}
    </section>
  );
}
