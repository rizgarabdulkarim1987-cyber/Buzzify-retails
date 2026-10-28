export type ErrorCode =
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "READ_ONLY"
  | "NOT_FOUND"
  // Business rules refused by an action's run (thrown as RuleError).
  | "PLAN_UNAVAILABLE"
  | "PLAN_LIMIT"
  | "CAPABILITY_CONFLICT"
  | "INVALID_TRANSITION"
  | "INVITATION_INVALID"
  | "INVITATION_EXPIRED"
  | "ALREADY_MEMBER"
  | "OWNER_EXISTS"
  | "BUSINESS_ARCHIVED";

export type Result<O> = { ok: true; value: O } | { ok: false; code: ErrorCode; message: string };

/** The message shown to the user for each code (Arabic, business language). */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  FORBIDDEN: "ليست لديك صلاحية لتنفيذ هذه العملية.",
  INVALID_INPUT: "البيانات المدخلة غير صحيحة، يرجى مراجعتها والمحاولة مرة أخرى.",
  VERSION_CONFLICT: "تم تعديل هذه البيانات من قبل مستخدم آخر. حدّث الصفحة ثم أعد المحاولة.",
  IDEMPOTENCY_MISMATCH: "تم استخدام معرّف هذه العملية سابقاً مع بيانات مختلفة.",
  READ_ONLY: "النشاط في وضع القراءة فقط حالياً، لا يمكن تنفيذ هذه العملية.",
  NOT_FOUND: "العنصر المطلوب غير موجود.",
  PLAN_UNAVAILABLE: "الباقة المختارة غير موجودة أو غير متاحة حالياً.",
  PLAN_LIMIT: "عدد الفروع المطلوب يتجاوز الحد المسموح في الباقة المختارة.",
  CAPABILITY_CONFLICT: "لا يمكن تفعيل تتبّع الأرقام التسلسلية وتتبّع الدفعات معاً في المنشأة نفسها حالياً.",
  INVALID_TRANSITION: "لا يمكن نقل المنشأة إلى هذه الحالة من حالتها الحالية.",
  INVITATION_INVALID: "رابط الدعوة غير صالح أو تم استخدامه أو استُبدل بدعوة أحدث.",
  INVITATION_EXPIRED: "انتهت صلاحية رابط الدعوة. اطلب من فريق Buzzify إرسال دعوة جديدة.",
  ALREADY_MEMBER: "أنت عضو في فريق هذه المنشأة مسبقاً.",
  OWNER_EXISTS: "لهذه المنشأة مالك مسجّل مسبقاً، لا يمكن إرسال دعوة مالك جديدة.",
  BUSINESS_ARCHIVED: "هذه المنشأة مؤرشفة، لا يمكن تنفيذ هذه العملية.",
});

/** Shown when something unexpected fails; never carries internal detail. */
export const INTERNAL_ERROR_MESSAGE = "حدث خطأ غير متوقع، لم يتم حفظ أي تغيير. يرجى المحاولة مرة أخرى.";

export function failure(code: ErrorCode): { ok: false; code: ErrorCode; message: string } {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

/** Thrown by updateVersioned when the row's version no longer matches (or the row is out of scope). */
export class VersionConflictError extends Error {
  override readonly name = "VersionConflictError";
  constructor() {
    super("VERSION_CONFLICT");
  }
}

/** Throw from an action's run when the target row does not exist for this actor. */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  constructor() {
    super("NOT_FOUND");
  }
}

/** The caller may not perform this action (e.g. not a platform admin, or the wrong invitee). */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
  constructor(detail = "FORBIDDEN") {
    super(detail);
  }
}

/**
 * Throw from an action's run to refuse on a business rule (the transaction rolls back and the
 * caller gets this code with its Arabic message).
 */
export class RuleError extends Error {
  override readonly name = "RuleError";
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

/** The same idempotency key was used with a different payload. */
export class IdempotencyMismatchError extends Error {
  override readonly name = "IdempotencyMismatchError";
  constructor() {
    super("IDEMPOTENCY_MISMATCH");
  }
}

/**
 * What a caller sees when an action fails unexpectedly: a generic Arabic message. The original
 * error is logged server-side and kept as `cause` for the caller's logger; nothing of it is in
 * `message`.
 */
export class InternalActionError extends Error {
  override readonly name = "InternalActionError";
  constructor(cause: unknown) {
    super(INTERNAL_ERROR_MESSAGE, { cause });
  }
}
