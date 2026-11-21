import {
  CheckCircleIcon,
  ChatBubbleBottomCenterTextIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import type { ComponentType, SVGProps } from "react";
import type { Verdict } from "../../shared/contracts";

/** Distinct shape per verdict, so the result never depends on colour alone. */
export const VERDICT_ICON: Record<Verdict, ComponentType<SVGProps<SVGSVGElement>>> = {
  POTWIERDZONE: CheckCircleIcon,
  FALSZYWE: XCircleIcon,
  WPROWADZAJACE: ExclamationTriangleIcon,
  BRAK_DOWODOW: QuestionMarkCircleIcon,
  NIE_PODLEGA: ChatBubbleBottomCenterTextIcon,
};
