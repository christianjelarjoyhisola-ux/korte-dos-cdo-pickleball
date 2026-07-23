export type ReceiptVerificationVerdict =
  | "auto_approved"
  | "manual_review"
  | "rejected";

export type CustomerReceiptStatus = "auto_approved" | "manual_review";

export type BookingPaymentOutcome = {
  status: "confirmed" | "pending";
  paymentStatus: "paid" | "downpayment_paid" | "for_verification";
  customerStatus: CustomerReceiptStatus;
  needsOwnerReview: boolean;
};

/**
 * A human decision is authoritative over the preserved automated receipt
 * verdict. For example, an owner-approved payment remains confirmed/paid even
 * when its original OCR verdict was "manual_review" or "rejected".
 */
export function customerStatusForProcessedBooking(
  receiptStatus: string,
  bookingStatus: string,
  paymentStatus: string,
): ReceiptVerificationVerdict {
  if (bookingStatus === "cancelled" || paymentStatus === "rejected") {
    return "rejected";
  }

  if (
    bookingStatus === "confirmed" ||
    bookingStatus === "completed" ||
    paymentStatus === "paid" ||
    paymentStatus === "downpayment_paid"
  ) {
    return "auto_approved";
  }

  if (receiptStatus === "rejected") return "rejected";
  if (receiptStatus === "manual_review") return "manual_review";
  return "auto_approved";
}

/**
 * Automated verification is allowed to confirm a payment, but it is never
 * allowed to cancel a customer's booking. Every non-approved receipt has
 * already been stored and is routed to the court owner for a human decision.
 */
export function bookingOutcomeForReceipt(
  verdict: ReceiptVerificationVerdict,
  expectedAmount: number,
  expectedTotal: number,
  tolerance = 5,
): BookingPaymentOutcome {
  if (verdict !== "auto_approved") {
    return {
      status: "pending",
      paymentStatus: "for_verification",
      customerStatus: "manual_review",
      needsOwnerReview: true,
    };
  }

  return {
    status: "confirmed",
    paymentStatus: expectedAmount >= expectedTotal - tolerance
      ? "paid"
      : "downpayment_paid",
    customerStatus: "auto_approved",
    needsOwnerReview: false,
  };
}
