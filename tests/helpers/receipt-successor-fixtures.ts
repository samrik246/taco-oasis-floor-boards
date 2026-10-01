// Synthetic UI transition data only; never imported by an application route.
import shared from "../../fixtures/receipts/v4-examples.json";
import closed from "../../fixtures/receipts/closed-batch-examples-v1.json";
import type { Batch, Response, Review } from "../../src/lib/receipts/protocol";

export const successorIds = closed.examples.identities;
export function successorReview(successor: boolean, now: number): Review {
  const data = structuredClone((shared.cases[0].scenarios[0].steps[0].expect as { response: Response }).response.data) as Review;
  const row = closed.examples.direct_b1_replay.response.data.documents[0];
  data.review_handle = successor ? "a".repeat(32) : "b".repeat(32);
  data.plan_handle = successor ? closed.examples.direct_b2_replay.response.data.plan_handle : closed.examples.direct_b1_replay.response.data.plan_handle;
  data.created_at = new Date(now).toISOString(); data.expires_at = new Date(now + 300000).toISOString();
  data.documents = [{ ...data.documents[0], document_handle: row.document_handle, reservation_handle: row.reservation_handle, reservation_revision: successor ? 4 : 1, role: row.role as "FRIO", device_id: row.device_id }];
  data.total_documents = 1; data.totals = [{ device_id: row.device_id, count: 1 }];
  return data;
}
export function eligibleClosedBatch(): Batch {
  const data = structuredClone(closed.examples.direct_b1_replay.response.data) as Batch;
  data.documents[0].reservation_revision = 3;
  data.documents[0].allowed_actions = ["review_pending"];
  return data;
}
export function successorResult(): Response {
  return structuredClone(closed.examples.direct_b2_replay.response) as Response;
}
