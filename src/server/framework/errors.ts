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
  | "BUSINESS_ARCHIVED"
  | "STEP_NOT_AVAILABLE"
  | "USER_NOT_FOUND"
  | "STAFF_EXISTS"
  | "DUPLICATE_NAME"
  | "CATEGORY_IN_USE"
  | "BARCODE_TAKEN"
  | "SKU_TAKEN"
  | "UNIT_RULE"
  | "TRACKING_RULE";

/**
 * `details`: optional safe facts about a refusal, for the UI to show next to the message (e.g.
 * BARCODE_TAKEN names the product that owns the code). Only ever data of the caller's own business.
 */
export type FailureDetails = Readonly<Record<string, string>>;

export type Result<O> =
  | { ok: true; value: O }
  | { ok: false; code: ErrorCode; message: string; details?: FailureDetails };

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
  STEP_NOT_AVAILABLE: "هذه الخطوة غير متاحة بعد، ستصل في إصدار قادم.",
  USER_NOT_FOUND: "لا يوجد حساب بهذا البريد الإلكتروني. اطلب من الموظف إنشاء حساب أولاً ثم أعد المحاولة.",
  STAFF_EXISTS: "هذا الشخص عضو في فريق المنشأة مسبقاً.",
  DUPLICATE_NAME: "يوجد عنصر بهذا الاسم مسبقاً.",
  CATEGORY_IN_USE: "لا يمكن أرشفة هذا القسم لأنه يحتوي على أقسام فرعية أو منتجات فعّالة.",
  BARCODE_TAKEN: "هذا الباركود مستخدم لصنف آخر في المنشأة (حتى لو كان مؤرشفاً).",
  SKU_TAKEN: "رمز الصنف (SKU) هذا مستخدم مسبقاً في المنشأة.",
  UNIT_RULE: "إعداد الوحدة غير مقبول: تحقق من معامل التحويل ودقة الكمية واسم الوحدة، ووحدة الأساس لا تُؤرشف ولا يتغير معاملها.",
  TRACKING_RULE: "إعداد التتبع غير مقبول: تتبّع الصلاحية يتطلب التتبع بالدفعات.",
});

/** Shown when something unexpected fails; never carries internal detail. */
export const INTERNAL_ERROR_MESSAGE = "حدث خطأ غير متوقع، لم يتم حفظ أي تغيير. يرجى المحاولة مرة أخرى.";

export function failure(
  code: ErrorCode,
  details?: FailureDetails,
): { ok: false; code: ErrorCode; message: string; details?: FailureDetails } {
  return details ? { ok: false, code, message: ERROR_MESSAGES[code], details } : { ok: false, code, message: ERROR_MESSAGES[code] };
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
  constructor(
    readonly code: ErrorCode,
    /** Safe facts for the caller (see FailureDetails); never internal detail. */
    readonly details?: FailureDetails,
  ) {
    super(code);
  }
}

/**
 * Support access refused (src/server/admin/support.ts): no such grant, someone else's grant,
 * revoked, expired, a scope the grant does not include, a closed business, or no longer a
 * platform admin. Always FORBIDDEN to the caller; `reason` is for logs and tests only.
 */
export class SupportAccessError extends Error {
  override readonly name = "SupportAccessError";
  constructor(
    readonly reason: "NO_GRANT" | "NOT_GRANTEE" | "REVOKED" | "EXPIRED" | "SCOPE_NOT_GRANTED" | "BUSINESS_CLOSED" | "NOT_PLATFORM_ADMIN",
  ) {
    super(`SUPPORT_ACCESS_${reason}`);
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
