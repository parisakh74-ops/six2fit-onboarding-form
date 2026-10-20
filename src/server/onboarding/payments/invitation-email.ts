/**
 * DRAFT copy of the first Onboarding invitation (Persian, right-to-left). THE WORDING IS NOT APPROVED: Product / UX must
 * approve the final text before real sending (see docs/onboarding/EMAIL_DELIVERY_ONB_DELIVERY_01.md). The message contains
 * the link and nothing else that is personal: no name, no answers, no health or payment data.
 */
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const INVITATION_SUBJECT = "فرم شروع برنامه شما در 6toFit";

export function renderInvitation(link: string): { subject: string; html: string } {
  const safe = escapeHtml(link);
  const html =
    `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;line-height:1.8">` +
    `<p>سلام،</p>` +
    `<p>پرداخت شما تأیید شد. برای شروع برنامه، لطفاً فرم زیر را تکمیل کنید:</p>` +
    `<p><a href="${safe}">تکمیل فرم</a></p>` +
    `<p style="direction:ltr;text-align:left;word-break:break-all">${safe}</p>` +
    `<p>این پیوند اختصاصی شماست؛ لطفاً آن را با دیگران به اشتراک نگذارید.</p>` +
    `</div>`;
  return { subject: INVITATION_SUBJECT, html };
}
