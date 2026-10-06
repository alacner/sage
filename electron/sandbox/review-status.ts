import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolCall } from '../../shared/types';
export type ReviewStatus = NonNullable<ToolCall['reviewStatus']>;
const status = new AsyncLocalStorage<(value: ReviewStatus) => void>();
export function reportReview(value: ReviewStatus) { status.getStore()?.(value); }
export async function withReviewStatus<T>(callback: (value: ReviewStatus) => void, run: () => Promise<T>) { let result:T; try { result=await status.run(callback, run); } catch(e) { throw e; } return result; }
