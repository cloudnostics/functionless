import type { aws_iam } from "aws-cdk-lib";
import type { Expr } from "@functionless/ast";
import type { VTL } from "@functionless/vtl";

export interface APIGatewayVTL extends VTL {
  role: aws_iam.IRole;
  /**
   * Attempt to return the expression as a valid escaped json string.
   *
   * ```ts
   * {
   *    x: input
   * }
   * ```
   *
   * =>
   *
   * ```ts
   * { "x": $input.json('$') }
   * ```
   *
   * =>
   *
   * ```ts
   * "{ \"x\": $util.escapeJavaScript($input.json('$')) }"
   * ```
   */
  stringify(expr: Expr): string;

  /**
   * Renders a VTL string that will emit a JSON String representation of the {@link expr} to the VTL output.
   *
   * @param expr the {@link Expr} to convert to JSON
   * @returns a VTL string that emits the {@link expr} as JSON
   */
  exprToJson(expr: Expr): string;
}
