import { BadRequestException } from '@nestjs/common';

/**
 * A transfer must use a suggestion made for the patient who is in the source bed: the
 * suggestion's rules (gender, age, needs) decided which beds are eligible for that patient.
 */
export function assertSuggestionFitsBed(
  suggestion: { request: { currentBedId?: string } },
  fromBedId: string,
  activeAdmission: { bed: unknown } | null,
): void {
  const fits = suggestion.request.currentBedId === fromBedId && !!activeAdmission && String(activeAdmission.bed) === fromBedId;
  if (!fits) throw new BadRequestException('This suggestion was made for a different patient or bed.');
}
