const ROASTS = [
  [0, "You'd approve a budget line for AWS Elastic Banana."],
  [3, 'You know S3. That is a start.'],
  [6, 'Solid. You have read at least one re:Invent recap.'],
  [10, "You clearly read the What's New feed for fun."],
  [16, 'Suspiciously good. Do you work here?'],
  [23, 'You might be the AWS service catalog.'],
];

export function roastFor(score) {
  let line = ROASTS[0][1];
  for (const [min, text] of ROASTS) if (score >= min) line = text;
  return line;
}
