"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { addOrderCommentAction } from "@/app/actions/order-comments";
import { buttonCls, inputCls } from "@/components/ui/form";

export function CommentForm({ orderId }: { orderId: string }) {
  const t = useTranslations("orders.comments");
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await addOrderCommentAction(orderId, body);
          if ("error" in r) {
            setError(t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : t("errors.other"));
            return;
          }
          setBody("");
          router.refresh();
        });
      }}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={2000}
        rows={3}
        aria-label={t("new")}
        placeholder={t("placeholder")}
        className={`${inputCls} min-h-20 py-2`}
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || body.trim().length < 2} className={buttonCls}>
          {pending ? t("adding") : t("add")}
        </button>
        {error && (
          <span role="alert" className="text-sm text-block">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
