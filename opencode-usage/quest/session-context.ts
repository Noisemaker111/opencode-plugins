import { QuestTracker } from "./runs/tracker"
import { QuestStore } from "./store"
import { questRoot } from "./root.mts"
const trackers=new Map<string,QuestTracker>()
export function questSessionContext(sessionID:string,root=questRoot()) {let tracker=trackers.get(root);if(!tracker){tracker=new QuestTracker(new QuestStore(root));trackers.set(root,tracker)}const ref=tracker.sessionIndex().get(sessionID);return ref?{questID:ref.questID,parentID:ref.session.parentID??ref.session.parentSessionID,runID:ref.session.runID,stepID:ref.session.deliverables.length===1?ref.session.deliverables[0]:undefined,reasoning:ref.session.reasoningEffort,harness:ref.session.runtime??ref.session.harness}:undefined}
