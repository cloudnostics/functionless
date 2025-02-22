import {
  anyOf,
  ArrowFunctionExpr,
  BindingDecl,
  BindingElem,
  BindingName,
  BindingPattern,
  BlockStmt,
  BreakStmt,
  CallExpr,
  ContinueStmt,
  DeterministicNameGenerator,
  ElementAccessExpr,
  emptySpan,
  evalToConstant,
  Expr,
  ForInStmt,
  FunctionExpr,
  FunctionlessNode,
  FunctionLike,
  Identifier,
  IfStmt,
  isArgument,
  isArrayBinding,
  isArrayLiteralExpr,
  isAwaitExpr,
  isBinaryExpr,
  isBindingElem,
  isBindingPattern,
  isBlockStmt,
  isBreakStmt,
  isCallExpr,
  isCallReferencePattern,
  isCaseClause,
  isCatchClause,
  isComputedPropertyNameExpr,
  isConditionExpr,
  isContinueStmt,
  isDebuggerStmt,
  isDefaultClause,
  isDoStmt,
  isElementAccessExpr,
  isEmptyStmt,
  isExprStmt,
  isForInStmt,
  isForOfStmt,
  isForStmt,
  isFunctionLike,
  isIdentifier,
  isIfStmt,
  isLabelledStmt,
  isLiteralExpr,
  isNewExpr,
  isNode,
  isObjectBinding,
  isObjectLiteralExpr,
  isOmittedExpr,
  isParameterDecl,
  isParenthesizedExpr,
  isPostfixUnaryExpr,
  isPromiseAll,
  isPropAccessExpr,
  isPropAssignExpr,
  isReferenceExpr,
  isReturnStmt,
  isSpreadAssignExpr,
  isStmt,
  isStringLiteralExpr,
  isSwitchStmt,
  isTemplateExpr,
  isThrowStmt,
  isTryStmt,
  isTypeOfExpr,
  isUnaryExpr,
  isUndefinedLiteralExpr,
  isVariableDecl,
  isVariableDeclList,
  isVariableReference,
  isVariableStmt,
  isVoidExpr,
  isWhileStmt,
  isWithStmt,
  NullLiteralExpr,
  ParameterDecl,
  PropAccessExpr,
  PropAssignExpr,
  ReturnStmt,
  SpreadAssignExpr,
  Stmt,
  tryFindReference,
  UniqueNameGenerator,
  VariableDecl,
  visitEachChild,
} from "@functionless/ast";

import type { Construct } from "constructs";
import type { aws_iam } from "aws-cdk-lib";
import { ASLGraph } from "./asl-graph";
import {
  Choice,
  CommonFields,
  Condition,
  Fail,
  isMapTaskState,
  isParallelTaskState,
  isTaskState,
  MapTask,
  Pass,
  State,
  StateMachine,
  States,
  Succeed,
  Wait,
} from "./states";
import { StepFunctionError } from "./step-function-error";
import { assertNever } from "@functionless/util";
import { SynthError, ErrorCodes } from "@functionless/error-code";
import {
  FUNCTIONLESS_CONTEXT_NAME,
  FUNCTIONLESS_CONTEXT_JSON_PATH,
} from "./constants";
import {
  EvalExprHandler,
  EvalExprContext,
  EvalContextHandler,
  EvalContextContext,
} from "./eval-expr-context";
import {
  canThrow,
  isMap,
  isForEach,
  isSlice,
  isFilter,
  isJoin,
  isIncludes,
  isJsonStringify,
  isJsonParse,
  isSplit,
  analyzeFlow,
} from "./guards";
import { Parameters } from "./states";
import { toStateName } from "./to-state-name";
import { isASLIntegration } from "./asl-integration";

/**
 * Amazon States Language (ASL) Generator.
 */
export class ASL {
  /**
   * A friendly name to identify the Functionless Context.
   */
  static readonly ContextName = "Amazon States Language";
  /**
   * Tag this instance with its Functionless Context ({@link this.ContextName})
   */
  readonly kind = ASL.ContextName;
  /**
   * The Amazon States Language (ASL) State Machine Definition synthesized fro the {@link decl}.
   */
  readonly definition: StateMachine<States>;
  /**
   * The {@link FunctionLike} AST representation of the State Machine.
   */
  readonly decl: FunctionLike;
  private readonly stateNamesGenerator = new UniqueNameGenerator(
    (name, n) => `${name} ${n}`
  );
  private readonly variableNamesGenerator = new UniqueNameGenerator(
    (name, n) => `${name}__${n}`
  );
  private readonly variableNamesMap = new Map<FunctionlessNode, string>();
  private readonly generatedNames = new DeterministicNameGenerator();

  /**
   * A pointer to the state used to continue.
   *
   * For and While loops should implement this state.
   */
  private static readonly ContinueNext: string = "__ContinueNext";

  /**
   * A pointer to the nearest break point.
   *
   * For and While loops should implement this state.
   */
  private static readonly BreakNext: string = "__BreakNext";

  /**
   * A pointer to the nearest catch state.
   */
  private static readonly CatchState: string = "__catch";

  private readonly contextParameter: undefined | ParameterDecl;

  constructor(
    readonly scope: Construct,
    readonly role: aws_iam.IRole,
    decl: FunctionLike
  ) {
    this.decl = decl = visitEachChild(decl, function normalizeAST(node):
      | FunctionlessNode
      | FunctionlessNode[] {
      if (isBlockStmt(node)) {
        return new BlockStmt(node.span, [
          // for each block statement
          ...node.statements.flatMap((stmt) => {
            const transformed = normalizeAST(stmt) as Stmt[];
            if (Array.isArray(transformed)) {
              return transformed;
            } else {
              return [transformed];
            }
          }),

          // re-write the AST to include explicit `ReturnStmt(NullLiteral())` statements
          // this simplifies the interpreter code by always having a node to chain onto, even when
          // the AST has no final `ReturnStmt` (i.e. when the function is a void function)
          // without this, chains that should return null will actually include the entire state as their output
          ...(isFunctionLike(node.parent) &&
          (!node.lastStmt || !node.lastStmt.isTerminal())
            ? [
                new ReturnStmt(
                  node.lastStmt?.span ?? node.span,
                  new NullLiteralExpr(node.lastStmt?.span ?? node.span)
                ),
              ]
            : []),
        ]);
      } else if (isForOfStmt(node) && node.isAwait) {
        throw new SynthError(
          ErrorCodes.Unsupported_Feature,
          `Step Functions does not yet support for-await, see https://github.com/functionless/functionless/issues/390`
        );
      } else if (isParameterDecl(node) && node.isRest) {
        throw new SynthError(
          ErrorCodes.Unsupported_Feature,
          `Step Functions does not yet support rest parameters, see https://github.com/functionless/functionless/issues/391`
        );
      }
      return visitEachChild(node, normalizeAST);
    });

    const [inputParam, contextParam] = this.decl.parameters;

    this.contextParameter = contextParam;

    // get the State Parameters and ASLGraph states to initialize any provided parameters (assignment and binding).
    const [paramInitializer, paramStates] =
      this.evalParameterDeclForStateParameter(
        this.decl,
        {
          parameter: inputParam,
          valuePath: ASLGraph.jsonPath("$$.Execution.Input"),
        },
        {
          // for the context parameter, we only want to assign up front if we need to bind parameter names.
          // in the case a simple `Identifier` is used as the parameter name, we'll inject the jsonPath "$$" later.
          // This should save us space on the state by not assigning the entire context object when not needed.
          parameter:
            contextParam && isBindingPattern(contextParam.name)
              ? contextParam
              : undefined,
          valuePath: ASLGraph.jsonPath("$$"),
        }
      );

    /**
     * Always inject this initial state into the machine. It does 3 things:
     *
     * 1. Adds the fnl_context which provides hard to generate values like null.
     * 2. assigns the input to the mutable input parameter name.
     * 3. Clears out the initial input from the state.
     *
     * The 3rd task is always required as the input could populate later generated variables.
     */
    const functionlessContext: Pass = {
      Type: "Pass",
      Parameters: {
        [FUNCTIONLESS_CONTEXT_NAME]: { null: null },
        ...paramInitializer,
      },
      ResultPath: "$",
      Next: ASLGraph.DeferNext,
    };

    const states = this.evalStmt(this.decl.body, {
      End: true,
      ResultPath: "$",
    });

    this.definition = this.aslGraphToStates(
      ASLGraph.joinSubStates(
        this.decl.body,
        functionlessContext,
        paramStates,
        states
      )!,
      "Initialize Functionless Context"
    );
  }

  /**
   * Access Functionless context variables in the machine state like the input to the machine.
   *
   * The Functionless context is only added to the machine when needed.
   * Using this property anywhere in a machine will add the context Pass state to the start of the machine.
   */
  public context = {
    null: `${FUNCTIONLESS_CONTEXT_JSON_PATH}.null`,
  };

  /**
   * Returns a unique name for a declaration.
   *
   * The first time we see a declaration, the name will be the same as the identifier name.
   *
   * All future unique declarations with the same name will see an incremented number suffixed to the identifier.
   *
   * ```ts
   * const a;
   * const a; // a__1
   * const a; // a__2
   * for(let a in []) // a__3
   * ```
   */
  private getDeclarationName(binding: BindingDecl & { name: Identifier }) {
    if (!this.variableNamesMap.get(binding)) {
      const name = binding.name.name;
      this.variableNamesMap.set(
        binding,
        this.variableNamesGenerator.getUnique(name)
      );
    }
    return this.variableNamesMap.get(binding);
  }

  /**
   * Returns the unique variable name which has been registered for this identifier.
   *
   * Expects an {@link Identifier} which has a discoverable declaration.
   *
   * @see getDeclarationName
   */
  private getIdentifierName(identifier: Identifier) {
    const ref = identifier.lookup();

    if (
      (isBindingElem(ref) || isParameterDecl(ref) || isVariableDecl(ref)) &&
      isIdentifier(ref.name)
    ) {
      return this.getDeclarationName(ref as BindingDecl & { name: Identifier });
    }
    throw new ReferenceError(`${identifier.name} is not defined`);
  }

  /**
   * Generates a valid, unique state name for the ASL machine.
   *
   * * Truncates the name to 75 characters
   * * If the name is already used, suffix with a unique number
   * * Cache both the truncated name and the suffixed name to prevent future collisions.
   */
  private createUniqueStateName(stateName: string): string {
    const truncatedStateName =
      stateName.length > 75 ? stateName.slice(0, 75) : stateName;
    return this.stateNamesGenerator.getUnique(truncatedStateName);
  }

  /**
   * Flattens a {@link ASLGraph.SubState} graph or {@link ASLGraph.NodeState} into a {@link States} collection.
   *
   * Provides a node naming strategy. (see `stmtName`).
   *
   * @param stmtName - The name to use to start the graph. When a SubState is given, the first state of the collection
   *                   with use the `stmtName`. All subsequent states either use the name of the `node` given or their local name
   *                   prefixed onto the parent name.
   *                   When a NodeState is given, the `stmtName` is used.
   */
  public aslGraphToStates(
    state: ASLGraph.NodeState | ASLGraph.SubState,
    overrideStateName?: string
  ): StateMachine<States> {
    const stmtName = this.createUniqueStateName(
      overrideStateName ?? (state.node ? toStateName(state.node) : "Default")
    );
    // build a map of local state names to their unique flattened form
    return {
      StartAt: stmtName,
      States: ASLGraph.toStates(
        stmtName,
        ASLGraph.updateDeferredNextStates({ End: true }, state),
        (parentName, states) => {
          return Object.fromEntries(
            Object.entries(states.states ?? {}).map(([name, state]) => [
              name,
              states.startState === name
                ? parentName
                : state.node
                ? this.createUniqueStateName(toStateName(state.node))
                : this.createUniqueStateName(`${name}__${parentName}`),
            ])
          );
        }
      ),
    };
  }

  /**
   * Evaluate a single {@link Stmt} into a collection of named states.
   *
   * @param returnPass partial Pass state which will be given the return value as input using {@link ASLGraph.passWithInput}.
   *                   provide the rest to determine the behavior of the returnStmt.
   */
  public evalStmt(
    stmt: Stmt,
    returnPass: Omit<Pass, "Type" | "InputPath" | "Parameters" | "Result"> &
      CommonFields
  ): ASLGraph.SubState | ASLGraph.NodeState | undefined {
    if (isBlockStmt(stmt)) {
      return ASLGraph.joinSubStates(
        stmt,
        ...stmt.statements.map((s) => {
          const states = this.evalStmt(s, returnPass);
          // ensure all of the states in a block have a node associated with them
          return states
            ? {
                ...states,
                node: s,
              }
            : undefined;
        })
      );
    } else if (isBreakStmt(stmt) || isContinueStmt(stmt)) {
      const loop = stmt.findParent(
        anyOf(isForOfStmt, isForInStmt, isForStmt, isWhileStmt, isDoStmt)
      );
      if (loop === undefined) {
        throw new Error("Stack Underflow");
      }

      return isBreakStmt(stmt)
        ? {
            node: stmt,
            Type: "Pass",
            Next: ASL.BreakNext,
          }
        : {
            node: stmt,
            Type: "Pass",
            Next: ASL.ContinueNext,
            ResultPath: null,
          };
    } else if (isExprStmt(stmt)) {
      const expr = this.eval(stmt.expr);

      // Expr Stmt throws away the constant or reference result of a statement.
      // Either apply the next statement to the returned sub-state
      // or create an empty pass
      // TODO: Minor optimization. Could we update references to this line to the next statement?
      //       or could we defer wiring the next states until we know which statements
      //       have outputs?
      if (ASLGraph.isOutputStateOrSubState(expr)) {
        return expr;
      } else {
        return {
          node: stmt,
          Type: "Pass",
          ResultPath: null,
          Next: ASLGraph.DeferNext,
        };
      }
    } else if (isForOfStmt(stmt) || isForInStmt(stmt)) {
      return this.evalExprToSubState(stmt.expr, (output) => {
        const body = this.evalStmt(stmt.stmt, returnPass);

        // assigns either a constant or json path to a new variable
        const assignTempState = this.assignValue(undefined, output);
        const tempArrayPath = assignTempState.output.jsonPath;

        const assignTemp = isForOfStmt(stmt)
          ? assignTempState
          : // if `ForIn`, map the array into a tuple of index and item
            ASLGraph.joinSubStates(stmt.expr, assignTempState, {
              ...this.zipArray(tempArrayPath, (indexJsonPath) =>
                ASLGraph.renderIntrinsicFunction(
                  ASLGraph.intrinsicFormat(
                    "{}",
                    ASLGraph.jsonPath(indexJsonPath)
                  )
                )
              ),
              ResultPath: tempArrayPath,
              Next: ASLGraph.DeferNext,
            })!;

        const initializer: ASLGraph.SubState | ASLGraph.NodeState = (() => {
          /**ForInStmt
           * Assign the value to $.0__[variableName].
           * Assign the index to the variable decl. If the variable decl is an identifier, it may be carried beyond the ForIn.
           */
          if (isForInStmt(stmt)) {
            const initializerName = isIdentifier(stmt.initializer)
              ? this.getIdentifierName(stmt.initializer)
              : isVariableDeclList(stmt.initializer) &&
                isIdentifier(stmt.initializer.decls[0].name)
              ? this.getDeclarationName(
                  stmt.initializer.decls[0] as VariableDecl & {
                    name: Identifier;
                  }
                )
              : undefined;

            if (initializerName === undefined) {
              throw new SynthError(
                ErrorCodes.Unexpected_Error,
                "The left-hand side of a 'for...in' statement cannot be a destructuring pattern."
              );
            }

            return {
              startState: "assignIndex",
              node: stmt.initializer,
              states: {
                assignIndex: {
                  Type: "Pass",
                  InputPath: `${tempArrayPath}[0].index`,
                  ResultPath: `$.${initializerName}`,
                  Next: "assignValue",
                },
                assignValue: {
                  Type: "Pass",
                  InputPath: `${tempArrayPath}[0].item`,
                  ResultPath: `$.0__${initializerName}`,
                  Next: ASLGraph.DeferNext,
                },
              },
            };
          } else {
            return isVariableDeclList(stmt.initializer)
              ? this.evalDecl(stmt.initializer.decls[0]!, {
                  jsonPath: `${tempArrayPath}[0]`,
                })!
              : isIdentifier(stmt.initializer)
              ? this.evalAssignment(stmt.initializer, {
                  jsonPath: `${tempArrayPath}[0]`,
                })!
              : (() => {
                  throw new SynthError(
                    ErrorCodes.Unsupported_Feature,
                    `expression ${stmt.initializer.nodeKind} is not supported as the initializer in a ForInStmt`
                  );
                })();
          }
        })();

        return {
          startState: "assignTemp",
          node: stmt,
          states: {
            assignTemp: ASLGraph.updateDeferredNextStates(
              { Next: "hasNext" },
              assignTemp
            ),
            hasNext: {
              Type: "Choice",
              Choices: [
                { ...ASL.isPresent(`${tempArrayPath}[0]`), Next: "assign" },
              ],
              Default: "exit",
            },
            /**
             * Assign the index to $.[variableName].
             * When the loop.variableDecl is an {@link Identifier} (not {@link VariableStmt}), the variable may be used after the for loop.
             */
            assign: ASLGraph.updateDeferredNextStates(
              { Next: "body" },
              initializer
            ),
            // any ASLGraph.DeferNext (or empty) should be wired to exit
            body: ASLGraph.updateDeferredNextStates(
              { Next: "tail" },
              body ?? {
                Type: "Pass",
                Next: ASLGraph.DeferNext,
              }
            ),
            // tail the array
            tail: {
              Type: "Pass",
              InputPath: `${tempArrayPath}[1:]`,
              ResultPath: tempArrayPath,
              Next: "hasNext", // restart by checking for items after tail
            },
            // clean up?
            exit: {
              Type: "Pass",
              Next: ASLGraph.DeferNext,
            },
            [ASL.ContinueNext]: {
              Type: "Pass",
              Next: "tail",
              node: new ContinueStmt(emptySpan()),
            },
            [ASL.BreakNext]: {
              Type: "Pass",
              Next: "exit",
              node: new BreakStmt(emptySpan()),
            },
          },
        };
      });
    } else if (isForStmt(stmt)) {
      const body = this.evalStmt(stmt.stmt, returnPass);

      return this.evalContextToSubState(stmt, ({ evalExpr }) => {
        const initializers = stmt.initializer
          ? isVariableDeclList(stmt.initializer)
            ? stmt.initializer.decls.map((x) => this.evalDecl(x))
            : [evalExpr(stmt.initializer)]
          : [undefined];

        const condStates = stmt.condition
          ? this.eval(stmt.condition)
          : undefined;
        const conditionOutput = condStates
          ? ASLGraph.getAslStateOutput(condStates)
          : undefined;

        const increment = stmt.incrementor
          ? this.eval(stmt.incrementor)
          : undefined;

        // run optional initializer
        return ASLGraph.joinSubStates(stmt, ...initializers, {
          startState: "check",
          states: {
            // check the condition (or do nothing)
            check:
              condStates && conditionOutput && stmt.condition
                ? // join the states required to execute the condition with the condition value.
                  // This ensures the condition supports short circuiting and runs all expressions as needed
                  ASLGraph.joinSubStates(
                    stmt.condition,
                    condStates,
                    // evaluate the condition json path to be truthy
                    ASLGraph.isJsonPath(conditionOutput) ||
                      ASLGraph.isConditionOutput(conditionOutput)
                      ? {
                          Type: "Choice",
                          Choices: [
                            {
                              ...(ASLGraph.isConditionOutput(conditionOutput)
                                ? conditionOutput.condition
                                : ASL.isTruthy(conditionOutput.jsonPath)),
                              Next: "body",
                            },
                          ],
                          Default: "exit",
                        }
                      : conditionOutput.value
                      ? // if the condition is a constant (`for(;true;){}`), hardcode a destination
                        { Type: "Pass", Next: "body" }
                      : { Type: "Pass", Next: "exit" }
                  )!
                : // no condition, for loop will require an explicit exit
                  { Type: "Pass", Next: "body" },
            // then run the body
            body: ASLGraph.updateDeferredNextStates(
              { Next: "increment" },
              body ?? {
                Type: "Pass",
                Next: ASLGraph.DeferNext,
              }
            ),
            // then increment (or do nothing)
            increment: ASLGraph.updateDeferredNextStates(
              { Next: "check" },
              increment && ASLGraph.isStateOrSubState(increment)
                ? increment
                : { Type: "Pass", Next: ASLGraph.DeferNext }
            ),
            // return back to check
            // TODO: clean up?
            exit: { Type: "Pass", Next: ASLGraph.DeferNext },
            [ASL.ContinueNext]: {
              Type: "Pass",
              Next: "check",
              node: new ContinueStmt(emptySpan()),
            },
            [ASL.BreakNext]: {
              Type: "Pass",
              Next: "exit",
              node: new BreakStmt(emptySpan()),
            },
          },
        })!;
      });
    } else if (isIfStmt(stmt)) {
      const collect = (curr: IfStmt): [IfStmt[], Stmt | undefined] => {
        if (curr._else) {
          if (isIfStmt(curr._else)) {
            const [ifs, el] = collect(curr._else);
            return [[curr, ...ifs], el];
          } else {
            return [[curr], curr._else];
          }
        }
        return [[curr], undefined];
      };

      const [ifs, els] = collect(stmt);

      const ifStates: Record<string, ASLGraph.SubState> = Object.fromEntries(
        ifs.map((_if, i) => {
          // the local state name used for the current if statement
          const stateName = i === 0 ? "if" : `if_${i}`;
          // the computed name of the next if or else statement's state
          const next =
            i + 1 < ifs.length
              ? `if_${i + 1}`
              : els
              ? "else"
              : ASLGraph.DeferNext;
          const condition = this.eval(_if.when);
          const conditionOutput = ASLGraph.getAslStateOutput(condition);
          const stmtStates = this.evalStmt(_if.then, returnPass);
          // to support short circuiting, each `if` statement run all states required for the condition
          // immediately before evaluating the condition.
          // if the condition returns true, run the body, if not, go to the next if statement.
          return [
            stateName,
            {
              startState: "condition",
              states: {
                // run any states required for the condition and then evaluate the output (short circuit)
                condition: ASLGraph.joinSubStates(_if.when, condition, {
                  Type: "Choice",
                  Choices: [
                    {
                      ...ASLGraph.isTruthyOutput(conditionOutput),
                      Next: "body",
                    },
                  ],
                  Default: next,
                })!,
                // if the condition is try, the body will be run
                body: stmtStates ?? { Type: "Pass", Next: ASLGraph.DeferNext },
              },
            },
          ];
        })
      );

      const elsState = els ? this.evalStmt(els, returnPass) : undefined;

      return {
        startState: "if",
        states: {
          ...ifStates,
          // provide an empty else statement. A choice default cannot terminate a sub-graph,
          // without a pass here, an if statement without else cannot end a block.
          // if the extra pass isn't needed, it will be pruned later
          else: elsState
            ? elsState
            : { Type: "Pass", Next: ASLGraph.DeferNext },
        },
      };
    } else if (isReturnStmt(stmt)) {
      return this.evalExprToSubState(
        stmt.expr ?? stmt.fork(new NullLiteralExpr(stmt.span)),
        (output, { addState }) => {
          const normalizedState = this.normalizeOutputToJsonPathOrLiteralValue(
            output,
            stmt.expr
          );
          const normalizedOutput = ASLGraph.isStateOrSubState(normalizedState)
            ? normalizedState.output
            : normalizedState;
          if (ASLGraph.isStateOrSubState(normalizedState)) {
            addState(normalizedState);
          }
          return ASLGraph.passWithInput(
            {
              Type: "Pass",
              ...returnPass,
            },
            normalizedOutput
          );
        }
      );
    } else if (isVariableStmt(stmt)) {
      return ASLGraph.joinSubStates(
        stmt,
        ...stmt.declList.decls.map((decl) => this.evalDecl(decl))
      );
    } else if (isThrowStmt(stmt)) {
      if (
        !(
          isNewExpr(stmt.expr) ||
          isCallExpr(stmt.expr) ||
          isCallReferencePattern(stmt.expr, isASLIntegration)
        )
      ) {
        throw new Error(
          "the expr of a ThrowStmt must be a NewExpr or CallExpr"
        );
      }

      const updated =
        isNewExpr(stmt.expr) || isCallExpr(stmt.expr)
          ? stmt.expr
          : stmt.expr.expr;

      const throwState = this.evalContextToSubState(updated, ({ evalExpr }) => {
        const errorClassName =
          // new StepFunctionError will be a ReferenceExpr with the name: Step
          isReferenceExpr(updated.expr) &&
          StepFunctionError.isConstructor(updated.expr.ref())
            ? StepFunctionError.kind
            : isReferenceExpr(updated.expr) || isIdentifier(updated.expr)
            ? updated.expr.name
            : isPropAccessExpr(updated.expr)
            ? updated.expr.name.name
            : undefined;

        // we support three ways of throwing errors within Step Functions
        // throw new Error(msg)
        // throw Error(msg)
        // throw StepFunctionError(cause, message);

        const { errorName, causeJson } = resolveErrorNameAndCause();

        const throwTransition = this.throw(stmt);
        if (throwTransition === undefined) {
          return {
            Type: "Fail",
            Error: errorName,
            Cause: JSON.stringify(causeJson),
          };
        } else {
          return {
            Type: "Pass",
            Result: causeJson,
            ...throwTransition,
          };
        }

        function resolveErrorNameAndCause(): {
          errorName: string;
          causeJson: unknown;
        } {
          if (errorClassName === "Error") {
            const errorMessage = updated.args[0]?.expr;
            if (
              errorMessage === undefined ||
              isUndefinedLiteralExpr(errorMessage)
            ) {
              return {
                errorName: "Error",
                causeJson: {
                  message: null,
                },
              };
            } else {
              return {
                errorName: "Error",
                causeJson: {
                  message: toJson(errorMessage),
                },
              };
            }
          } else if (errorClassName === "StepFunctionError") {
            const [error, cause] = updated.args.map(({ expr }) => expr);
            if (error === undefined || cause === undefined) {
              // this should never happen if typescript type checking is enabled
              // hence why we don't add a new ErrorCode for it
              throw new SynthError(
                ErrorCodes.Unexpected_Error,
                `Expected 'error' and 'cause' parameter in StepFunctionError`
              );
            }
            const errorName = toJson(error);
            if (typeof errorName !== "string") {
              // this should never happen if typescript type checking is enabled
              // hence why we don't add a new ErrorCode for it
              throw new SynthError(
                ErrorCodes.Unexpected_Error,
                `Expected 'error' parameter in StepFunctionError to be of type string, but got ${typeof errorName}`
              );
            }
            try {
              return {
                errorName,
                causeJson: toJson(cause),
              };
            } catch (err: any) {
              throw new SynthError(
                ErrorCodes.StepFunctions_error_cause_must_be_a_constant,
                err.message
              );
            }
          } else {
            throw new SynthError(
              ErrorCodes.StepFunction_Throw_must_be_Error_or_StepFunctionError_class
            );
          }
        }

        /**
         * Attempts to convert a Node into a JSON object.
         *
         * Only literal expression types are supported - no computation.
         */
        function toJson(expr: Expr): unknown {
          const val = evalExpr(expr);
          if (!ASLGraph.isLiteralValue(val) || val.containsJsonPath) {
            throw new SynthError(
              ErrorCodes.StepFunctions_error_cause_must_be_a_constant
            );
          }
          return val.value;
        }
      });

      return { ...throwState, node: stmt };
    } else if (isTryStmt(stmt)) {
      const tryFlow = analyzeFlow(stmt.tryBlock);

      const errorVariableName = stmt.catchClause
        ? this.generatedNames.generateOrGet(stmt.catchClause)
        : undefined;

      const tryState = {
        startState: "try",
        node: stmt.tryBlock,
        states: {
          try: this.evalStmt(stmt.tryBlock, returnPass) ?? {
            Type: "Pass",
            ResultPath: null,
            Next: ASLGraph.DeferNext,
          },
          // create a special catch clause that is only visible to states in the try block
          ...(stmt.catchClause
            ? { [ASL.CatchState]: { Type: "Pass", Next: "catch" } }
            : {}),
        },
      };

      const tryFlowStates =
        tryFlow.hasTask && stmt.catchClause?.variableDecl
          ? ASLGraph.joinSubStates(
              stmt.catchClause.variableDecl,
              ASLGraph.assignJsonPathOrIntrinsic(
                ASLGraph.intrinsicStringToJson(
                  ASLGraph.jsonPath(`$.${errorVariableName}.Cause`)
                ),
                `$.${errorVariableName}`,
                "0_ParsedError"
              ),
              {
                Type: "Pass",
                InputPath: `$.${errorVariableName}.0_ParsedError`,
                ResultPath: `$.${errorVariableName}`,
                Next: ASLGraph.DeferNext,
              }
            )
          : undefined;

      const catchClauseState = stmt.catchClause
        ? {
            startState: "catch",
            states: {
              catch: ASLGraph.joinSubStates(
                stmt.catchClause,
                tryFlowStates,
                this.evalStmt(stmt.catchClause, returnPass)
              ) ?? { Type: "Pass", Next: ASLGraph.DeferNext },
              // if there is a finally, make sure any thrown errors in catch are handled
              ...(stmt.finallyBlock
                ? {
                    [ASL.CatchState]: {
                      Type: "Pass",
                      Next: "finally",
                    },
                  }
                : {}),
            },
          }
        : undefined;

      const finallyState = stmt.finallyBlock
        ? ASLGraph.joinSubStates(
            stmt.finallyBlock,
            // finally block, which may be empty.
            this.evalStmt(stmt.finallyBlock, returnPass) ?? {
              Type: "Pass",
              ResultPath: null,
              Next: ASLGraph.DeferNext,
            },
            stmt.catchClause && canThrow(stmt.catchClause)
              ? (() => {
                  if (stmt.finallyBlock.isTerminal()) {
                    // if every branch in the finallyBlock is terminal (meaning it always throws or returns)
                    // then we don't need the exit and throw blocks of a finally - because the finally
                    // will always return
                    // this is an extreme edge case
                    // see: https://github.com/microsoft/TypeScript/issues/27454
                    return undefined;
                  }
                  const throwTarget = this.throw(stmt.finallyBlock);
                  const errVariable = `$.${this.generatedNames.generateOrGet(
                    stmt.finallyBlock
                  )}`;
                  return {
                    startState: "exit",
                    states: {
                      exit: {
                        // when exiting the finally block, if we entered via an error, then we need to re-throw the error
                        Type: "Choice",
                        Choices: [
                          {
                            // errors thrown from the catch block will be directed to this special variable for the `finally` block
                            Variable: errVariable,
                            IsPresent: true,
                            Next: `throw`,
                          },
                        ],
                        Default: ASLGraph.DeferNext,
                      },
                      throw: throwTarget
                        ? {
                            Type: "Pass",
                            InputPath: errVariable,
                            ...throwTarget,
                          }
                        : {
                            Type: "Fail",
                            Error: "ReThrowFromFinally",
                            Cause:
                              "an error was re-thrown from a finally block which is unsupported by Step Functions",
                          },
                    },
                  };
                })()
              : undefined
          )!
        : undefined;

      return {
        startState: "try",
        node: stmt,
        states: {
          try: finallyState
            ? // if there is a finally, go there next
              ASLGraph.updateDeferredNextStates({ Next: "finally" }, tryState)
            : tryState,
          ...(catchClauseState
            ? {
                catch: finallyState
                  ? // if there is a finally, go there next
                    ASLGraph.updateDeferredNextStates(
                      { Next: "finally" },
                      catchClauseState
                    )
                  : catchClauseState,
              }
            : {}),
          ...(finallyState ? { finally: finallyState } : {}),
        },
      };
    } else if (isCatchClause(stmt)) {
      const _catch = this.evalStmt(stmt.block, returnPass) ?? {
        Type: "Pass",
        Next: ASLGraph.DeferNext,
      };
      const initialize = stmt.variableDecl
        ? this.evalDecl(stmt.variableDecl, {
            jsonPath: `$.${this.generatedNames.generateOrGet(stmt)}`,
          })
        : undefined;
      return ASLGraph.joinSubStates(stmt, initialize, _catch);
    } else if (isWhileStmt(stmt) || isDoStmt(stmt)) {
      const blockState = this.evalStmt(stmt.stmt, returnPass);
      if (!blockState) {
        throw new SynthError(
          ErrorCodes.Unexpected_Error,
          `a ${stmt.kindName} block must have at least one Stmt`
        );
      }
      return this.evalExprToSubState(stmt.condition, (conditionOutput) => {
        return {
          startState: "check",
          states: {
            check: {
              Type: "Choice",
              node: stmt.condition,
              Choices: [
                {
                  ...ASLGraph.isTruthyOutput(conditionOutput),
                  Next: "whenTrue",
                },
              ],
              Default: ASLGraph.DeferNext,
            },
            // return to check until complete
            whenTrue: ASLGraph.updateDeferredNextStates(
              { Next: "check" },
              blockState
            ),
            [ASL.ContinueNext]: {
              Type: "Pass",
              node: new ContinueStmt(emptySpan()),
              Next: "check",
            },
            [ASL.BreakNext]: {
              Type: "Pass",
              node: new BreakStmt(emptySpan()),
              Next: ASLGraph.DeferNext,
            },
          },
        };
      });
    } else if (isDebuggerStmt(stmt) || isEmptyStmt(stmt)) {
      return undefined;
    } else if (isLabelledStmt(stmt)) {
      return this.evalStmt(stmt.stmt, returnPass);
    } else if (isWithStmt(stmt)) {
      throw new SynthError(
        ErrorCodes.Unsupported_Feature,
        `with statements are not yet supported by ASL`
      );
    } else if (
      isSwitchStmt(stmt) ||
      isCaseClause(stmt) ||
      isDefaultClause(stmt)
    ) {
      // see: https://github.com/functionless/functionless/issues/306
      throw new SynthError(
        ErrorCodes.Unsupported_Feature,
        `switch statements are not yet supported in Step Functions, see https://github.com/functionless/functionless/issues/306`
      );
    }
    return assertNever(stmt);
  }

  /**
   * Recursively evaluate a single expression, building a single {@link ASLGraph.NodeResults} object.
   *
   * Any states generated from the original expression or contextual helper functions in {@link handler}
   * will be merged into a single {@link ASLGraph.NodeResults} object at the end.
   *
   * @param expr - Expression to evaluate.
   * @param handler - A handler callback which receives the {@link ASLGraph.Output} resolved from the expression.
   *                  This output will represent the constant or variable representing the output of the expression.
   *                  An `addState` callback is also provided to inject additional states into the graph.
   *                  The state will be joined (@see ASLGraph.joinSubStates ) with the previous and next states in the order received.
   */
  public evalExpr<Result extends ASLGraph.NodeResults = ASLGraph.NodeResults>(
    expr: Expr,
    handler: EvalExprHandler<any, Result>
  ): Result;
  /**
   * Recursively evaluate a single expression, building a single {@link ASLGraph.NodeResults} object.
   *
   * Any states generated from the original expression or contextual helper functions in {@link handler}
   * will be merged into a single {@link ASLGraph.NodeResults} object at the end.
   *
   * @param expr - Expression to evaluate.
   * @param contextNode - Node to associate with the output state. This node may be used to name the resulting state.
   *                      Otherwise expr is used.
   * @param handler - A handler callback which receives the {@link ASLGraph.Output} resolved from the expression.
   *                  This output will represent the constant or variable representing the output of the expression.
   *                  An `addState` callback is also provided to inject additional states into the graph.
   *                  The state will be joined (@see ASLGraph.joinSubStates ) with the previous and next states in the order received.
   */
  public evalExpr<Result extends ASLGraph.NodeResults = ASLGraph.NodeResults>(
    expr: Expr,
    contextNode: FunctionlessNode,
    handler: EvalExprHandler<any, Result>
  ): Result;
  public evalExpr<Result extends ASLGraph.NodeResults = ASLGraph.NodeResults>(
    expr: Expr,
    nodeOrHandler: FunctionlessNode | EvalExprHandler<any, Result>,
    maybeHandler?: EvalExprHandler<any, Result>
  ): Result {
    const [node, handler] = isNode(nodeOrHandler)
      ? [nodeOrHandler, maybeHandler!]
      : [expr, nodeOrHandler];

    const [exprState, states] = this.evalExprBase<ASLGraph.NodeResults>(
      expr,
      handler
    );

    const exprStateOutput = ASLGraph.getAslStateOutput(exprState);

    const joined = ASLGraph.joinSubStates(node, ...states, exprState);

    return (
      joined
        ? {
            ...joined,
            output: exprStateOutput,
          }
        : exprStateOutput
    ) as any;
  }

  /**
   * Recursively evaluate a single expression, building a single {@link ASLGraph.NodeResults} object.
   *
   * Any states generated from the original expression or contextual helper functions in {@link handler}
   * will be merged into a single {@link ASLGraph.NodeResults} object at the end.
   *
   * If the {@link ASLGraph.Output} of the expression is not a {@link ASLGraph.JsonPath}, it will be normalized into one.
   *
   * * If the output was a {@link ASLGraph.LiteralValue}, a new state will be added that turns the literal into a json path.
   * * If the output was a {@link ASLGraph.JsonPath}, the output is returned.
   * * If the output was a {@link ASLGraph.ConditionOutput}, a new {@link Choice} state will turn the conditional into a boolean
   *   and return a {@link ASLGraph.JsonPath}.
   *
   * @param expr - Expression to evaluate.
   * @param handler - A handler callback which receives the {@link ASLGraph.JsonPath} resolved from the expression.
   *                  This output will represent the constant or variable representing the output of the expression.
   *                  An `addState` callback is also provided to inject additional states into the graph.
   *                  The state will be joined (@see ASLGraph.joinSubStates ) with the previous and next states in the order received.
   */
  public evalExprToJsonPath(
    expr: Expr,
    handler: EvalExprHandler<ASLGraph.JsonPath>
  ): ASLGraph.NodeResults;
  /**
   * Recursively evaluate a single expression, building a single {@link ASLGraph.NodeResults} object.
   *
   * Any states generated from the original expression or contextual helper functions in {@link handler}
   * will be merged into a single {@link ASLGraph.NodeResults} object at the end.
   *
   * If the {@link ASLGraph.Output} of the expression is not a {@link ASLGraph.JsonPath}, it will be normalized into one.
   *
   * * If the output was a {@link ASLGraph.LiteralValue}, a new state will be added that turns the literal into a json path.
   * * If the output was a {@link ASLGraph.JsonPath}, the output is returned.
   * * If the output was a {@link ASLGraph.ConditionOutput}, a new {@link Choice} state will turn the conditional into a boolean
   *   and return a {@link ASLGraph.JsonPath}.
   *
   * @param expr - Expression to evaluate.
   * @param contextNode - Optional node to associate with the output state. This node may be used to name the resulting state.
   *                      Otherwise expr is used.
   * @param handler - A handler callback which receives the {@link ASLGraph.JsonPath} resolved from the expression.
   *                  This output will represent the constant or variable representing the output of the expression.
   *                  An `addState` callback is also provided to inject additional states into the graph.
   *                  The state will be joined (@see ASLGraph.joinSubStates ) with the previous and next states in the order received.
   */
  public evalExprToJsonPath(
    expr: Expr,
    contextNode: FunctionlessNode,
    handler: EvalExprHandler<ASLGraph.JsonPath>
  ): ASLGraph.NodeResults;
  public evalExprToJsonPath(
    expr: Expr,
    nodeOrHandler: FunctionlessNode | EvalExprHandler<ASLGraph.JsonPath>,
    maybeHandler?: EvalExprHandler<ASLGraph.JsonPath>
  ): ASLGraph.NodeResults {
    const [node, handler] = isNode(nodeOrHandler)
      ? [nodeOrHandler, maybeHandler!]
      : [expr, nodeOrHandler];

    return this.evalExpr(expr, node, (_, context) => {
      const normalized = context.normalizeOutputToJsonPath();
      return handler(normalized, context);
    });
  }

  /**
   * Recursively evaluate a single expression, building a single {@link ASLGraph.NodeResults} object.
   *
   * Any states generated from the original expression or contextual helper functions in {@link handler}
   * will be merged into a single {@link ASLGraph.NodeResults} object at the end.
   *
   * If the {@link ASLGraph.Output} of the expression is not a {@link ASLGraph.JsonPath} or {@link ASLGraph.LiteralValue}, it will be normalized into one.
   *
   * * If the output is a {@link ASLGraph.LiteralValue}, the output is returned as is.
   * * If the output was a {@link ASLGraph.JsonPath}, the output is returned as is.
   * * If the output was a {@link ASLGraph.ConditionOutput}, a new {@link Choice} state will turn the conditional into a boolean
   *   and return a {@link ASLGraph.JsonPath}.
   *
   * @param expr - Expression to evaluate.
   * @param handler - A handler callback which received the {@link ASLGraph.Output} resolved from the expression.
   *                  This output will represent the constant or variable representing the output of the expression.
   *                  An `addState` callback is also provided to inject additional states into the graph.
   *                  The state will be joined (@see ASLGraph.joinSubStates ) with the previous and next states in the order received.
   */
  public evalExprToJsonPathOrLiteral(
    expr: Expr,
    handler: EvalExprHandler<ASLGraph.JsonPath | ASLGraph.LiteralValue>
  ): ASLGraph.NodeResults;
  /**
   * Recursively evaluate a single expression, building a single {@link ASLGraph.NodeResults} object.
   *
   * Any states generated from the original expression or contextual helper functions in {@link handler}
   * will be merged into a single {@link ASLGraph.NodeResults} object at the end.
   *
   * If the {@link ASLGraph.Output} of the expression is not a {@link ASLGraph.JsonPath} or {@link ASLGraph.LiteralValue}, it will be normalized into one.
   *
   * * If the output is a {@link ASLGraph.LiteralValue}, the output is returned as is.
   * * If the output was a {@link ASLGraph.JsonPath}, the output is returned as is.
   * * If the output was a {@link ASLGraph.ConditionOutput}, a new {@link Choice} state will turn the conditional into a boolean
   *   and return a {@link ASLGraph.JsonPath}.
   *
   * @param expr - Expression to evaluate.
   * @param contextNode - Optional node to associate with the output state. This node may be used to name the resulting state.
   *                      Otherwise expr is used.
   * @param handler - A handler callback which received the {@link ASLGraph.Output} resolved from the expression.
   *                  This output will represent the constant or variable representing the output of the expression.
   *                  An `addState` callback is also provided to inject additional states into the graph.
   *                  The state will be joined (@see ASLGraph.joinSubStates ) with the previous and next states in the order received.
   */
  public evalExprToJsonPathOrLiteral(
    expr: Expr,
    contextNode: FunctionlessNode,
    handler: EvalExprHandler<ASLGraph.JsonPath | ASLGraph.LiteralValue>
  ): ASLGraph.NodeResults;
  public evalExprToJsonPathOrLiteral(
    expr: Expr,
    nodeOrHandler:
      | FunctionlessNode
      | EvalExprHandler<ASLGraph.JsonPath | ASLGraph.LiteralValue>,
    maybeHandler?: EvalExprHandler<ASLGraph.JsonPath | ASLGraph.LiteralValue>
  ): ASLGraph.NodeResults {
    const [node, handler] = isNode(nodeOrHandler)
      ? [nodeOrHandler, maybeHandler!]
      : [expr, nodeOrHandler];

    return this.evalExpr(expr, node, (output, context) => {
      const normalizedState =
        this.normalizeOutputToJsonPathOrLiteralValue(output);

      if (ASLGraph.isStateOrSubState(normalizedState)) {
        context.addState(normalizedState);
      }

      const newOutput = ASLGraph.isStateOrSubState(normalizedState)
        ? normalizedState.output
        : normalizedState;

      return handler(newOutput, context);
    });
  }

  /**
   * Recursively evaluate a single expression, building a single {@link ASLGraph.NodeResults} object.
   * All SubStates generated during evaluation will be merged into a {@link ASLGraph.SubState}.
   *
   * @param expr - Expression to evaluate.
   * @param handler - A handler callback which receives the {@link ASLGraph.Output} resolved from the expression.
   *                  This output will represent the constant or variable representing the output of the expression.
   */
  private evalExprToSubState(
    expr: Expr,
    handler: (
      output: ASLGraph.Output,
      context: EvalExprContext
    ) => ASLGraph.SubState | ASLGraph.NodeState | undefined
  ): ASLGraph.SubState | ASLGraph.NodeState | undefined {
    const [exprState, states] = this.evalExprBase(expr, handler);

    return ASLGraph.joinSubStates(expr, ...states, exprState);
  }

  /**
   * evalExpr* functions provide a stateful closure that simplifies the evaluation
   * of an expression into {@link ASLGraph} states and {@link ASLGraph.Output}s.
   *
   * Unlike {@link eval} which requires manually joining of states, evalExpr* methods
   * maintain an array of that that we joined together at the end. They reduce control,
   * but reduce the work to generate valid ASLGraphs.
   */
  private evalExprBase<T>(
    expr: Expr,
    handler: (output: ASLGraph.Output, context: EvalExprContext) => T
  ): [T, (ASLGraph.SubState | ASLGraph.NodeState | undefined)[]] {
    // evaluate the expression, returning an output and optional state or substate(s)
    const state = this.eval(expr);
    // get the output from the evaluated expression state
    const output = ASLGraph.getAslStateOutput(state);

    // collect all intermediate states including the operation one(s) evaluated from the expression
    // additional states may be added by the caller using addState or normalizeOutputToJsonPath
    // these states will be returned to the caller to be joined together.
    const states: (ASLGraph.NodeState | ASLGraph.SubState)[] =
      ASLGraph.isStateOrSubState(state) ? [state] : [];

    // call the handler given by the caller with the output and helper functions
    const handlerOutput = handler(output, {
      // allows the user to add arbitrary states to the sequence of states
      addState: (state) => {
        states.push(state);
      },
      normalizeOutputToJsonPath: () => {
        const normalized = this.normalizeOutputToJsonPath(output);
        if (ASLGraph.isStateOrSubState(normalized)) {
          states.push(normalized);
        }
        return ASLGraph.isJsonPath(normalized) ? normalized : normalized.output;
      },
      normalizeOutputToJsonPathOrLiteral: () => {
        const normalized = this.normalizeOutputToJsonPathOrLiteralValue(output);
        if (ASLGraph.isStateOrSubState(normalized)) {
          states.push(normalized);
        }
        return ASLGraph.isStateOrSubState(normalized)
          ? normalized.output
          : normalized;
      },
    });

    // return the value generated by the handler and any intermediate states generated
    // by eval, `addState`, or `normalizeOutputToJsonPath`.
    return [handlerOutput, states];
  }

  /**
   * Returns the states required to normalize any {@link ASLGraph.Output} into a {@link ASLGraph.JsonPath}.
   *
   * * If the output was a {@link ASLGraph.LiteralValue}, a new state will be added that turns the literal into a json path.
   * * If the output was a {@link ASLGraph.JsonPath}, the output is returned.
   * * If the output was a {@link ASLGraph.ConditionOutput}, a new {@link Choice} state will turn the conditional into a boolean
   *   and return a {@link ASLGraph.JsonPath}.
   */
  private normalizeOutputToJsonPath(
    output: ASLGraph.Output,
    node?: FunctionlessNode
  ):
    | ((ASLGraph.OutputState | ASLGraph.OutputSubState) & {
        output: ASLGraph.JsonPath;
      })
    | ASLGraph.JsonPath {
    if (ASLGraph.isJsonPath(output)) {
      return output;
    } else {
      return this.assignValue(node, output);
    }
  }

  /**
   * returns the states required to normalize a {@link ASLGraph.Output} into a {@link ASLGraph.JsonPath} or {@link ASLGraph.LiteralValue}.
   *
   * * If the output is a {@link ASLGraph.LiteralValue}, the output is returned as is.
   * * If the output was a {@link ASLGraph.JsonPath}, the output is returned as is.
   * * If the output was a {@link ASLGraph.ConditionOutput}, a new {@link Choice} state will turn the conditional into a boolean
   *   and return a {@link ASLGraph.JsonPath}.
   */
  private normalizeOutputToJsonPathOrLiteralValue(
    output: ASLGraph.Output,
    node?: FunctionlessNode
  ):
    | (ASLGraph.OutputSubState & { output: ASLGraph.JsonPath })
    | ASLGraph.JsonPath
    | ASLGraph.LiteralValue {
    if (ASLGraph.isJsonPath(output) || ASLGraph.isLiteralValue(output)) {
      return output;
    } else {
      return this.conditionState(node, output.condition);
    }
  }

  /**
   * Provides a contextual `evalExpr` and `evalCondition` functions to the handler provided.
   * Any SubStates generated using the provided functions will be joined into a single {@link ASLGraph.OutputSubState}
   * with the output of the handler.
   *
   * All SubStates generated during evaluation will be merged into a {@link ASLGraph.OutputSubState} along with the output
   * of the handler callback.
   *
   * @param expr - Expression to evaluate.
   * @param contextNode - Optional node to associate with the output state. This node may be used to name the resulting state.
   *                      Otherwise expr is used.
   * @param handler - A handler callback which receives the contextual `evalExpr` function. The out of this handler will be
   *                  joined with any SubStates created from the `evalExpr` function.
   */
  public evalContext<T extends ASLGraph.NodeResults>(
    contextNode: FunctionlessNode | undefined,
    handler: EvalContextHandler<T>
  ): T {
    const [handlerState, states] = this.evalContextBase<T>(handler);
    const handlerStateOutput = ASLGraph.getAslStateOutput(handlerState);

    const joined = ASLGraph.joinSubStates(contextNode, ...states, handlerState);

    return (
      joined
        ? {
            ...joined,
            output: handlerStateOutput,
          }
        : handlerStateOutput
    ) as any;
  }

  /**
   * Internal method similar to {@link evalContext}.
   *
   * Unlike {@link evalContext}, this method does not return an output with the State or SubState.
   *
   * Used by the {@link evalStmt} cases which do not need an output (the output is determined by the stmt).
   *
   * @see evalContext for more details.
   */
  private evalContextToSubState(
    contextNode: FunctionlessNode | undefined,
    handler: (
      context: EvalContextContext
    ) => ASLGraph.SubState | ASLGraph.NodeState
  ): ASLGraph.SubState | ASLGraph.NodeState {
    const [handlerOut, states] = this.evalContextBase(handler);

    return ASLGraph.joinSubStates(contextNode, ...states, handlerOut)!;
  }

  /**
   * Base logic shared by {@link evalContext} and {@link evalContextToSubState}.
   *
   * @see evalContext for more details.
   */
  private evalContextBase<T>(
    handler: (context: EvalContextContext) => T
  ): [T, (ASLGraph.SubState | ASLGraph.NodeState)[]] {
    const states: (ASLGraph.SubState | ASLGraph.NodeState)[] = [];
    const context: EvalContextContext = {
      evalExpr: (expr: Expr, allowUndefined?: boolean) => {
        const state = this.eval(expr, allowUndefined);
        const output = ASLGraph.getAslStateOutput(state);
        if (ASLGraph.isOutputStateOrSubState(state)) {
          states.push(state);
        }
        return output;
      },
      addState: (state) => {
        states.push(state);
      },
      evalExprToJsonPath: (expr: Expr, allowUndefined?: boolean) => {
        const state = this.eval(expr, allowUndefined);
        const output = ASLGraph.getAslStateOutput(state);
        const normalizedStates = this.normalizeOutputToJsonPath(output, expr);
        const normalizedOutput = ASLGraph.isOutputStateOrSubState(
          normalizedStates
        )
          ? normalizedStates.output
          : normalizedStates;
        if (ASLGraph.isOutputStateOrSubState(state)) {
          states.push(state);
        }
        if (ASLGraph.isOutputStateOrSubState(normalizedStates)) {
          states.push(normalizedStates);
        }
        return normalizedOutput;
      },
      evalExprToJsonPathOrLiteral: (expr: Expr, allowUndefined?: boolean) => {
        const state = this.eval(expr, allowUndefined);
        const output = ASLGraph.getAslStateOutput(state);
        const normalizedStates = this.normalizeOutputToJsonPathOrLiteralValue(
          output,
          expr
        );
        const normalizedOutput = ASLGraph.isOutputStateOrSubState(
          normalizedStates
        )
          ? normalizedStates.output
          : normalizedStates;
        if (ASLGraph.isOutputStateOrSubState(state)) {
          states.push(state);
        }
        if (ASLGraph.isOutputStateOrSubState(normalizedStates)) {
          states.push(normalizedStates);
        }
        return normalizedOutput;
      },
      normalizeOutputToJsonPath: (output) => {
        const normalized = this.normalizeOutputToJsonPath(output);
        if (ASLGraph.isStateOrSubState(normalized)) {
          states.push(normalized);
        }
        return ASLGraph.isJsonPath(normalized) ? normalized : normalized.output;
      },
      normalizeOutputToJsonPathOrLiteral: (output) => {
        const normalized = this.normalizeOutputToJsonPathOrLiteralValue(output);
        if (ASLGraph.isStateOrSubState(normalized)) {
          states.push(normalized);
        }
        return ASLGraph.isStateOrSubState(normalized)
          ? normalized.output
          : normalized;
      },
      assignValue: (value, targetJsonPath?) => {
        const assigned = this.assignValue(undefined, value, targetJsonPath);

        if (ASLGraph.isStateOrSubState(assigned)) {
          states.push(assigned);
        }

        return ASLGraph.isStateOrSubState(assigned)
          ? assigned.output
          : assigned;
      },
    };
    return [handler(context), states];
  }

  /**
   * Evaluate an {@link Expr} to a single {@link State}.
   *
   * Method is private. External consumers should use use {@link evalContext} or {@link evalExpr}.
   *
   * @param expr the {@link Expr} to evaluate.
   * @param allowUndefined - when true, does not fail on undefined values. The resulting output literal may contain `value: undefined`.
   * @returns the {@link ASLGraph.Output} generated by an expression or an {@link ASLGraph.OutputSubState} with additional states and outputs.
   */
  private eval(
    expr: Expr,
    allowUndefined: boolean = false
  ): ASLGraph.NodeResults {
    // first check to see if the expression can be turned into a constant.
    const constant = evalToConstant(expr);
    if (constant !== undefined) {
      const value = constant.constant;
      if (!allowUndefined && value === undefined) {
        throw new SynthError(
          ErrorCodes.Step_Functions_does_not_support_undefined,
          `Undefined literal is not supported: ${toStateName(expr.parent)}`
        );
      }
      // manufacturing null can be difficult, just use our magic constant
      return value === null
        ? { jsonPath: this.context.null }
        : {
            value: value as any,
            containsJsonPath: false,
          };
    }

    if (isTemplateExpr(expr)) {
      return this.evalContext(expr, ({ evalExpr, addState }) => {
        const elementOutputs = [
          {
            value: expr.head.text,
            containsJsonPath: false,
          },
          ...expr.spans.flatMap((span) => {
            const out = evalExpr(span.expr);

            /**
             * It is possible that expressions in the template can update variables used in the template.
             * For JsonPath outputs assign the output of any json path to a new heap variable
             * instead of whatever json path they return. Do the same for conditions, they need have a boolean assigned
             * to a heap variable anyways. We can handle jsonPath and conditions in the same way.
             *
             *
             * ```ts
             * let x = "1";
             * ${x} ${(x = "2")}` // should output `1 2`
             * ```
             *
             * If the heap assignment isn't necessary, we will optimize out the extra assignment later.
             */
            const safeOut = ASLGraph.isLiteralValue(out)
              ? out
              : this.assignValue(span, out);

            if (ASLGraph.isStateOrSubState(safeOut)) {
              addState(safeOut);
            }

            return [
              ASLGraph.isAslGraphOutput(safeOut) ? safeOut : safeOut.output,
              {
                value: span.literal.text,
                containsJsonPath: false,
              },
            ];
          }),
        ];

        /**
         * Step Functions `States.Format` has a bug which fails when a jsonPath does not start with a
         * alpha character.
         * https://twitter.com/sussmansa/status/1542777348616990720?s=20&t=2PepSKvzPhojs_x01WoQVQ
         *
         * For this edge case, we re-assign each json path to a heap variable and use the heap location
         * in the States.Format call to ensure we don't fail to deploy.
         */
        const jsonPaths = elementOutputs
          .filter(ASLGraph.isJsonPath)
          .map((jp) =>
            jp.jsonPath.match(/\$\.[^a-zA-Z]/g)
              ? [jp, ASLGraph.jsonPath(this.newHeapVariable())]
              : ([jp, jp] as const)
          );

        // generate any pass states to rewrite variables as needed
        // we expect this to only happen rarely
        const rewriteStates: Pass[] = jsonPaths
          .filter(([original, updated]) => original !== updated)
          .map(([original, updated]) => ({
            Type: "Pass",
            InputPath: original.jsonPath,
            ResultPath: updated.jsonPath,
            Next: ASLGraph.DeferNext,
          }));

        rewriteStates.map(addState);

        return this.assignJsonPathOrIntrinsic(
          ASLGraph.intrinsicFormat(
            elementOutputs
              .map((output) =>
                ASLGraph.isJsonPath(output)
                  ? "{}"
                  : ASLGraph.escapeFormatLiteral(output)
              )
              .join(""),
            ...jsonPaths.map(([, jp]) => jp)
          ),
          "string",
          undefined,
          expr
        );
      });
    } else if (isCallExpr(expr)) {
      const integration = tryFindReference(expr.expr, isASLIntegration);
      if (integration) {
        const integStates = integration.asl(expr, this);

        if (ASLGraph.isAslGraphOutput(integStates)) {
          return integStates;
        }

        const updateState = (state: ASLGraph.NodeState): ASLGraph.NodeState => {
          const throwOrPass = this.throw(expr);
          if (
            throwOrPass?.Next &&
            (isTaskState(state) ||
              isMapTaskState(state) ||
              isParallelTaskState(state))
          ) {
            return {
              ...state,
              Catch: [
                {
                  ErrorEquals: ["States.ALL"],
                  Next: throwOrPass.Next,
                  ResultPath: throwOrPass.ResultPath,
                },
              ],
            };
          } else {
            return state;
          }
        };

        const updateStates = (
          states: ASLGraph.NodeState | ASLGraph.SubState
        ): ASLGraph.NodeState | ASLGraph.SubState => {
          return ASLGraph.isSubState(states)
            ? {
                ...states,
                states: Object.fromEntries(
                  Object.entries(states.states ?? {}).map(
                    ([stateName, state]) => {
                      if (ASLGraph.isSubState(state)) {
                        return [stateName, updateStates(state)];
                      } else {
                        return [stateName, updateState(state)];
                      }
                    }
                  )
                ),
              }
            : updateState(states);
        };
        return {
          node: integStates.node,
          output: integStates.output,
          ...updateStates(integStates),
        };
      } else if (isMap(expr)) {
        return this.mapToStateOutput(expr);
      } else if (isForEach(expr)) {
        return this.forEachToStateOutput(expr);
      } else if (isSlice(expr)) {
        return this.sliceToStateOutput(expr);
      } else if (isFilter(expr)) {
        return this.filterToStateOutput(expr);
      } else if (isJoin(expr)) {
        return this.joinToStateOutput(expr);
      } else if (isIncludes(expr)) {
        return this.includesToASLGraph(expr);
      } else if (isPromiseAll(expr)) {
        const values = expr.args[0]?.expr;
        if (values) {
          return this.eval(values);
        }
        throw new SynthError(ErrorCodes.Unsupported_Use_of_Promises);
      } else if (isJsonStringify(expr) || isJsonParse(expr)) {
        const objParamExpr = expr.args[0]?.expr;
        if (!objParamExpr || isUndefinedLiteralExpr(objParamExpr)) {
          if (expr.expr.name.name === "stringify") {
            // return an undefined variable
            return {
              jsonPath: this.newHeapVariable(),
            };
          } else {
            throw new SynthError(
              ErrorCodes.Invalid_Input,
              "JSON.parse in a StepFunction must have a single, defined parameter."
            );
          }
        }

        return this.evalExprToJsonPath(objParamExpr, (output) => {
          return this.assignJsonPathOrIntrinsic(
            isJsonStringify(expr)
              ? ASLGraph.intrinsicJsonToString(output)
              : ASLGraph.intrinsicStringToJson(output)
          );
        });
      } else if (isSplit(expr)) {
        const [splitter, limit] = expr.args;

        if (!splitter) {
          throw new SynthError(
            ErrorCodes.Invalid_Input,
            "Step Functions String Split splitter argument is required"
          );
        }

        return this.evalContext(expr, ({ evalExprToJsonPathOrLiteral }) => {
          const valueOut = evalExprToJsonPathOrLiteral(expr.expr.expr);
          const splitterOut = evalExprToJsonPathOrLiteral(splitter.expr);

          if (
            ASLGraph.isLiteralValue(valueOut) &&
            !ASLGraph.isLiteralString(valueOut)
          ) {
            throw new SynthError(
              ErrorCodes.Invalid_Input,
              "Step Functions String Split must be on a reference or string literal."
            );
          }

          if (
            ASLGraph.isLiteralValue(splitterOut) &&
            !ASLGraph.isLiteralString(splitterOut)
          ) {
            throw new SynthError(
              ErrorCodes.Invalid_Input,
              "Step Functions String Split splitter argument must be a reference or string literal."
            );
          }

          if (
            ASLGraph.isLiteralString(valueOut) &&
            ASLGraph.isLiteralString(splitterOut)
          ) {
            const limitOut = limit
              ? evalExprToJsonPathOrLiteral(limit.expr)
              : undefined;
            if (limitOut && !ASLGraph.isLiteralNumber(limitOut)) {
              throw new SynthError(
                ErrorCodes.Unsupported_Feature,
                "Step Function String Split limit must be a constant number"
              );
            }

            if (limit) {
              throw new SynthError(
                ErrorCodes.Unsupported_Feature,
                "String Split limit argument is not supported Step Functions"
              );
            }

            return ASLGraph.literalValue(
              valueOut.value.split(splitterOut.value, limitOut?.value)
            );
          }

          return this.assignJsonPathOrIntrinsic(
            ASLGraph.intrinsicStringSplit(valueOut, splitterOut)
          );
        });
      } else if (isReferenceExpr(expr.expr)) {
        const ref = expr.expr.ref();
        if (ref === Boolean) {
          const [arg] = expr.args;
          if (!arg) {
            return {
              value: false,
              containsJsonPath: false,
            };
          }
          return this.evalExpr(arg.expr, (argOutput) => {
            if (ASLGraph.isJsonPath(argOutput)) {
              return { condition: ASL.isTruthy(argOutput.jsonPath) };
            } else if (ASLGraph.isConditionOutput(argOutput)) {
              return argOutput;
            } else {
              return { value: !!argOutput.value, containsJsonPath: false };
            }
          });
        } else if (ref === String) {
          const [arg] = expr.args;
          return this.evalToString(arg?.expr);
        } else if (ref === Number) {
          const [arg] = expr.args;
          return this.evalToNumber(arg?.expr);
        }
      }
      throw new Error(
        `call must be an integration call, list(.slice, .map, .forEach, .filter, or ` +
          `.join), String.split, Number(), Boolean, String(), JSON.parse, JSON.stringify, or Promise.all, found: ${toStateName(
            expr
          )}`
      );
    } else if (isVariableReference(expr)) {
      if (isIdentifier(expr)) {
        const ref = expr.lookup();
        /**
         * Support the optional second parameter context reference.
         * async (input, context) => return context;
         *
         * context -> '$$'
         */
        if (
          ref &&
          isParameterDecl(ref) &&
          isFunctionLike(ref.parent) &&
          ref.parent === this.decl &&
          ref.parent.parameters[1] === ref
        ) {
          return { jsonPath: `$$` };
        }
        return { jsonPath: `$.${this.getIdentifierName(expr)}` };
      } else if (isPropAccessExpr(expr)) {
        if (isIdentifier(expr.name)) {
          return this.evalContext(expr.expr, ({ evalExpr }) => {
            const output = evalExpr(
              expr.expr,
              allowUndefined && expr.isOptional
            );
            if (ASLGraph.isLiteralValue(output) && output.value === undefined) {
              return ASLGraph.literalValue(undefined);
            }

            if (expr.name.name === "length") {
              const lengthAccess = this.accessLengthProperty(output);
              if (lengthAccess) {
                return lengthAccess;
              }
            }
            return ASLGraph.accessConstant(
              output,
              ASLGraph.literalValue(expr.name.name),
              false
            );
          });
        } else {
          throw new SynthError(ErrorCodes.Classes_are_not_supported);
        }
      } else if (isElementAccessExpr(expr)) {
        return this.elementAccessExprToJsonPath(expr, allowUndefined);
      }
      assertNever(expr);
    } else if (isObjectLiteralExpr(expr)) {
      return this.evalContext(
        expr,
        ({
          evalExprToJsonPathOrLiteral,
          assignValue,
          normalizeOutputToJsonPath,
        }) => {
          if (
            !expr.properties.every(
              (p): p is SpreadAssignExpr | PropAssignExpr =>
                isSpreadAssignExpr(p) || isPropAssignExpr(p)
            )
          ) {
            throw new SynthError(
              ErrorCodes.Unsupported_Feature,
              `Amazon States Language only supports property or spread assignments in Object Literals.`
            );
          }

          // evaluate all of the properties in the object literal
          const allOutputs = expr.properties.flatMap((prop, i) => {
            const propValueOutput =
              i === expr.properties.length - 1
                ? evalExprToJsonPathOrLiteral(prop.expr)
                : evalSafeOutput(prop);

            if (isSpreadAssignExpr(prop)) {
              if (ASLGraph.isLiteralValue(propValueOutput)) {
                if (
                  propValueOutput.value === undefined ||
                  propValueOutput.value === null
                ) {
                  return [];
                } else if (!ASLGraph.isLiteralObject(propValueOutput)) {
                  throw new SynthError(
                    ErrorCodes.Invalid_Input,
                    "Object spread can be only be done on objects, undefined, or null."
                  );
                }
              }

              return propValueOutput;
            } else {
              const name = propertyName(prop);

              return ASLGraph.literalValue(
                ASLGraph.jsonAssignment(name, propValueOutput),
                ASLGraph.isJsonPath(propValueOutput) ||
                  propValueOutput.containsJsonPath
              );
            }
          });

          // try to merge the sequential literals together
          const assignmentOutputs = allOutputs
            .reduce(
              (
                partitions: (
                  | ASLGraph.JsonPath
                  | ASLGraph.LiteralValue<
                      Record<string, ASLGraph.LiteralValueType>
                    >
                )[],
                output
              ): (
                | ASLGraph.JsonPath
                | ASLGraph.LiteralValue<
                    Record<string, ASLGraph.LiteralValueType>
                  >
              )[] => {
                const [prev, ...rest] = partitions;

                if (!prev) {
                  return [output, ...rest];
                } else if (
                  ASLGraph.isJsonPath(prev) ||
                  ASLGraph.isJsonPath(output)
                ) {
                  return [output, ...partitions];
                } else {
                  // both are literal objects, merge them
                  const merged = ASLGraph.mergeLiteralObject(prev, output);
                  return [merged, ...rest];
                }
              },
              []
            )
            .reverse();

          if (assignmentOutputs.length === 0) {
            // empty object
            return ASLGraph.literalValue({});
          } else if (assignmentOutputs.length === 1 && assignmentOutputs[0]) {
            // all literal or only one spread object
            return assignmentOutputs[0];
          } else {
            // merge jsonMath(1, jsonMarge(2, 3))
            // we know there are at least 2 items in the array, normalize all to json path and merge in order
            return this.assignJsonPathOrIntrinsic(
              assignmentOutputs
                .map((output): ASLGraph.IntrinsicFunction | ASLGraph.JsonPath =>
                  ASLGraph.isJsonPath(output)
                    ? output
                    : output.containsJsonPath
                    ? normalizeOutputToJsonPath(output)
                    : ASLGraph.intrinsicStringToJson(
                        ASLGraph.literalValue(JSON.stringify(output.value))
                      )
                )
                // items are in reverse order, reduce right
                .reduce(ASLGraph.intrinsicJsonMerge)
            );
          }

          /**
           * A json path value may be mutated late in the literal object assignment.
           * Re-reference the json path to ensure the value doesn't change.
           * ```ts
           * let b = { x: 0 };
           * {
           *    a: b,
           *    ...b,
           *    c: (b = { x: 1, y: 2 }),
           *    ...b,
           * }
           * ```
           * in ASL
           * ```
           * let b = {x: 0};
           * let t0 = b;
           * let t1 = b;
           * let t2 = (b = { x: 1, y: 2});
           * {
           *    a: t0,
           *    ...t1,
           *    c: t2,
           *    ...b // no mutation after the last assignment, this is safe to be a reference
           * }
           * ```
           */
          function evalSafeOutput(
            prop: PropAssignExpr | SpreadAssignExpr
          ): ASLGraph.LiteralValue | ASLGraph.JsonPath {
            const output = evalExprToJsonPathOrLiteral(prop.expr);
            return ASLGraph.isJsonPath(output) &&
              // paths at $$ are immutable, it is not necessary to reference their value because it will not change.
              !output.jsonPath.startsWith("$$.")
              ? assignValue(output)
              : output;
          }
        }
      );

      function propertyName(prop: PropAssignExpr) {
        if (
          (isComputedPropertyNameExpr(prop.name) &&
            isStringLiteralExpr(prop.name.expr)) ||
          isIdentifier(prop.name) ||
          isStringLiteralExpr(prop.name)
        ) {
          const name = isIdentifier(prop.name)
            ? prop.name.name
            : isStringLiteralExpr(prop.name)
            ? prop.name.value
            : isStringLiteralExpr(prop.name.expr)
            ? prop.name.expr.value
            : undefined;
          if (name) {
            return name;
          }
        }
        throw new SynthError(
          ErrorCodes.StepFunctions_property_names_must_be_constant
        );
      }
    } else if (isArrayLiteralExpr(expr)) {
      return this.evalContext(expr, ({ evalExpr, addState }) => {
        // evaluate each item
        const items = expr.items.map((item) => {
          if (isOmittedExpr(item)) {
            throw new SynthError(
              ErrorCodes.Step_Functions_does_not_support_undefined,
              `omitted expressions in an array create an undefined value which cannot be represented in Step Functions`
            );
          }
          const value = evalExpr(item);
          const assign =
            ASLGraph.isLiteralValue(value) && typeof value.value !== "object"
              ? undefined
              : this.assignValue(undefined, value);
          if (assign) {
            addState(assign);
            return assign.output;
          }
          return value as ASLGraph.LiteralValue<
            Exclude<ASLGraph.LiteralValueType, Record<string, any> | any[]>
          >;
        });

        return this.assignJsonPathOrIntrinsic(
          ASLGraph.intrinsicArray(...items),
          undefined,
          undefined,
          expr
        );
      });
    } else if (isLiteralExpr(expr)) {
      return {
        value: expr.value ?? null,
        containsJsonPath: false,
      };
    } else if (isVoidExpr(expr)) {
      return this.evalExpr(expr.expr, () => {
        return <ASLGraph.NodeResults>{
          output: {
            value: null,
          },
        };
      });
    } else if (isUnaryExpr(expr) || isPostfixUnaryExpr(expr)) {
      if (expr.op === "!") {
        const constant = evalToConstant(expr);
        if (constant !== undefined) {
          return {
            value: !constant.constant,
            containsJsonPath: false,
          };
        } else {
          return this.evalExpr(expr.expr, (output) => {
            return this.conditionState(
              expr,
              ASL.not(ASLGraph.isTruthyOutput(output))
            );
          });
        }
      } else if (expr.op === "+") {
        return this.evalToNumber(expr.expr);
      } else if (expr.op === "-") {
        return this.negateExpr(expr.expr);
      } else if (expr.op === "++" || expr.op === "--") {
        if (!isVariableReference(expr.expr)) {
          throw new SynthError(
            ErrorCodes.Unexpected_Error,
            "Expected left side of assignment to be a variable."
          );
        }
        return this.evalExpr(expr.expr, (output) => {
          if (!ASLGraph.isJsonPath(output)) {
            throw new SynthError(
              ErrorCodes.Unexpected_Error,
              `Expected assignment to target a variable, found: ${
                ASLGraph.isLiteralValue(output) ? output.value : "boolean"
              }`
            );
          }

          const mutateExpression = ASLGraph.intrinsicMathAdd(
            output,
            expr.op === "++" ? 1 : -1
          );
          const mutateResult = this.assignJsonPathOrIntrinsic(mutateExpression);

          if (isUnaryExpr(expr)) {
            return {
              ...ASLGraph.joinSubStates(
                undefined,
                // update into a new variable
                mutateResult,
                // update the variable
                this.assignValue(
                  undefined,
                  mutateResult.output,
                  output.jsonPath
                )
              )!,
              // return the new variable
              output: mutateResult.output,
            };
          } else {
            const assignResult = this.assignValue(undefined, output);
            return {
              ...ASLGraph.joinSubStates(
                expr,
                // assign the value to a new variable
                assignResult,
                // update the new variable
                mutateResult,
                // update the original value
                this.assignValue(
                  undefined,
                  mutateResult.output,
                  output.jsonPath
                )
              )!,
              // return the original value
              output: assignResult.output,
            };
          }
        });
      } else if (expr.op === "~") {
        throw new SynthError(
          ErrorCodes.Cannot_perform_all_arithmetic_or_bitwise_computations_on_variables_in_Step_Function,
          `Step Function does not support operator ${expr.op}`
        );
      }
      assertNever(expr.op);
    } else if (isBinaryExpr(expr)) {
      const constant = evalToConstant(expr);
      if (constant !== undefined) {
        return {
          value: constant as unknown as ASLGraph.LiteralValueType,
          containsJsonPath: false,
        };
      } else if (
        expr.op === "===" ||
        expr.op === "==" ||
        expr.op == "!=" ||
        expr.op == "!==" ||
        expr.op == ">" ||
        expr.op == "<" ||
        expr.op == ">=" ||
        expr.op == "<="
      ) {
        const op = expr.op;
        return this.evalContext(expr, ({ evalExpr }) => {
          const leftOutput = evalExpr(expr.left, true);
          const rightOutput = evalExpr(expr.right, true);
          return {
            condition: ASLGraph.compareOutputs(leftOutput, rightOutput, op),
          };
        });
      } else if (expr.op === "=") {
        if (!isVariableReference(expr.left)) {
          throw new SynthError(
            ErrorCodes.Unexpected_Error,
            "Expected left side of assignment to be a variable."
          );
        }
        return this.evalContext(expr, ({ evalExpr }) => {
          const right = evalExpr(expr.right);
          const left = evalExpr(expr.left);

          if (!ASLGraph.isJsonPath(left)) {
            throw new SynthError(
              ErrorCodes.Unexpected_Error,
              `Expected assignment to target a variable, found: ${
                ASLGraph.isLiteralValue(left) ? left.value : "boolean"
              }`
            );
          }

          return {
            ...this.assignValue(expr, right, left.jsonPath),
            output: right,
          };
        });
      } else if (expr.op === "in") {
        return this.evalContext(
          expr,
          ({ evalExprToJsonPathOrLiteral, normalizeOutputToJsonPath }) => {
            const left = evalExprToJsonPathOrLiteral(expr.left);
            const right = evalExprToJsonPathOrLiteral(expr.right);
            if (ASLGraph.isLiteralValue(left)) {
              if (
                ASLGraph.isLiteralString(left) ||
                ASLGraph.isLiteralNumber(left)
              ) {
                return ASLGraph.isLiteralValue(right)
                  ? // if the left and right are literal values, evaluate the expression now
                    ASLGraph.literalValue(
                      ASLGraph.isLiteralObject(right) &&
                        left.value in right.value
                    )
                  : ASLGraph.isConditionOutput(right)
                  ? // `in` is invalid with a boolean value
                    ASLGraph.literalValue(false)
                  : // if the left is a literal value, but the right is a json path, check to see if the left is present in the right
                    ASLGraph.conditionOutput(ASLGraph.elementIn(left, right));
              }
              throw new SynthError(
                ErrorCodes.StepFunctions_Invalid_collection_access,
                "Collection element accessor must be a constant string or number"
              );
            } else {
              const normArrayOutput = normalizeOutputToJsonPath(right);

              const arrayLength = this.assignJsonPathOrIntrinsic(
                ASLGraph.intrinsicArrayLength(normArrayOutput)
              );

              const _catch = this.throw(expr);

              return this.disambiguateArrayObject(
                normArrayOutput,
                {
                  startState: "length",
                  states: {
                    length: ASLGraph.updateDeferredNextStates(
                      { Next: "check" },
                      arrayLength
                    ),
                    check: this.conditionState(
                      undefined,
                      ASL.and(
                        ASL.numericLessThanPath(
                          left.jsonPath,
                          arrayLength.output.jsonPath
                        ),
                        ASL.numericGreaterThanEquals(left.jsonPath, 0)
                      ),
                      undefined,
                      undefined,
                      arrayLength.output.jsonPath
                    ),
                  },
                },
                _catch
                  ? {
                      Type: "Pass",
                      Parameters: {
                        error: "Functionless.InvalidAccess",
                        cause:
                          "Reference element access is not valid for objects.",
                      },
                      ..._catch,
                    }
                  : {
                      Type: "Fail",
                      Error: "Functionless.InvalidAccess",
                      Cause:
                        "Reference element access is not valid for objects.",
                    },
                arrayLength.output.jsonPath,
                true
              );
            }
          }
        );
      } else if (expr.op === ",") {
        return this.evalContext(expr, ({ evalExpr }) => {
          // eval left and discard the result
          evalExpr(expr.left);
          // eval right and return the result
          return evalExpr(expr.right);
        });
      } else if (expr.op === "+") {
        return this.evalContext(expr, ({ evalExprToJsonPathOrLiteral }) => {
          // todo support literals
          const leftOut = evalExprToJsonPathOrLiteral(expr.left);
          const rightOut = evalExprToJsonPathOrLiteral(expr.right);

          return this.plus(leftOut, rightOut, expr);
        });
      } else if (expr.op === "-") {
        return this.evalContext(expr, ({ evalExprToJsonPathOrLiteral }) => {
          const leftOut = evalExprToJsonPathOrLiteral(expr.left);
          const rightOut = evalExprToJsonPathOrLiteral(expr.right);

          return this.minus(leftOut, rightOut);
        });
      } else if (
        expr.op === "*" ||
        expr.op === "/" ||
        expr.op === "%" ||
        expr.op === "*=" ||
        expr.op === "/=" ||
        expr.op === "%=" ||
        expr.op === "&" ||
        expr.op === "&=" ||
        expr.op === "**" ||
        expr.op === "**=" ||
        expr.op === "<<" ||
        expr.op === "<<=" ||
        expr.op === ">>" ||
        expr.op === ">>=" ||
        expr.op === ">>>" ||
        expr.op === ">>>=" ||
        expr.op === "^" ||
        expr.op === "^=" ||
        expr.op === "|" ||
        expr.op === "|="
      ) {
        // TODO: support string concat - https://github.com/functionless/functionless/issues/330
        throw new SynthError(
          ErrorCodes.Cannot_perform_all_arithmetic_or_bitwise_computations_on_variables_in_Step_Function,
          `Step Function does not support operator ${expr.op}`
        );
      } else if (expr.op === "instanceof") {
        throw new SynthError(
          ErrorCodes.Unsupported_Feature,
          `Step Function does not support ${expr.op} operator`
        );
      } else if (expr.op === "&&" || expr.op === "||" || expr.op === "??") {
        return this.evalContext(expr.left, ({ evalExpr }) => {
          const leftOutput = evalExpr(expr.left, true);
          const right = this.eval(expr.right);

          if (ASLGraph.isLiteralValue(leftOutput)) {
            // if both values are literals, return a literal.
            // Only evaluate right as a literal if it is strictly a literal with no states.
            if (ASLGraph.isLiteralValue(right)) {
              return {
                value:
                  expr.op === "&&"
                    ? leftOutput.value && right.value
                    : expr.op === "||"
                    ? leftOutput.value || right.value
                    : leftOutput.value ?? right.value,
                containsJsonPath: false,
              };
            }

            /**
             * If left is a literal, evaluate the truthiness and return left or right.
             * &&: when truthy, return right
             * ||: when falsy, return right
             * ??: when undefined or null, return right
             */
            if (expr.op === "&&") {
              return !leftOutput.value ? leftOutput : right;
            } else if (expr.op === "||") {
              return leftOutput.value ? leftOutput : right;
            } else {
              return leftOutput.value !== null && leftOutput.value !== undefined
                ? leftOutput
                : right;
            }
          }

          /**
           * If the right is strictly a condition (no states), return a condition.
           */
          if (ASLGraph.isConditionOutput(right)) {
            if (ASLGraph.isConditionOutput(leftOutput)) {
              return {
                condition:
                  expr.op === "&&"
                    ? ASL.and(leftOutput.condition, right.condition)
                    : expr.op === "||"
                    ? ASL.or(leftOutput.condition, right.condition)
                    : // ??: a boolean cannot be undefined or null, return the left side.
                      leftOutput.condition,
              };
            }
          }

          /**
           * ??: runs right when the left is null or undefined.
           */
          if (expr.op === "??") {
            // (a === b) ?? c - c is unreachable
            if (ASLGraph.isConditionOutput(leftOutput)) {
              return leftOutput;
            }
            // a ?? b
            return this.conditionState(
              expr,
              ASL.isPresentAndNotNull(leftOutput.jsonPath),
              leftOutput,
              right
            );
          }

          /**
           * &&: return left when the left is falsy, else right
           * ||: return left when the right is truthy, else right
           */
          const condition = ASLGraph.isConditionOutput(leftOutput)
            ? expr.op === "&&"
              ? ASL.not(leftOutput.condition)
              : leftOutput.condition
            : expr.op === "&&"
            ? ASL.not(ASL.isTruthy(leftOutput.jsonPath))
            : ASL.isTruthy(leftOutput.jsonPath);

          return this.conditionState(expr, condition, leftOutput, right);
        });
      } else if (
        expr.op === "??=" ||
        expr.op === "&&=" ||
        expr.op === "||=" ||
        expr.op === "+=" ||
        expr.op === "-="
      ) {
        if (!isVariableReference(expr.left)) {
          throw new SynthError(
            ErrorCodes.Unexpected_Error,
            "Expected left side of assignment to be a variable."
          );
        }
        return this.evalContext(
          expr,
          ({ addState, evalExpr, evalExprToJsonPathOrLiteral }) => {
            const left = evalExpr(expr.left);

            if (!ASLGraph.isJsonPath(left)) {
              throw new SynthError(
                ErrorCodes.Unexpected_Error,
                `Expected assignment to target a variable, found: ${
                  ASLGraph.isLiteralValue(left) ? left.value : "boolean"
                }`
              );
            }

            if (expr.op === "??=" || expr.op === "||=" || expr.op === "&&=") {
              const right = this.eval(expr.right);
              /**
               * &&: left ? right : left
               * ||: left ? left : right
               * ??: left !== undefined && left !== null ? left : right
               */
              const condition =
                expr.op === "||="
                  ? ASL.isTruthy(left.jsonPath)
                  : expr.op === "&&="
                  ? ASL.not(ASL.isTruthy(left.jsonPath))
                  : ASL.isPresentAndNotNull(left.jsonPath);

              return this.conditionState(
                expr,
                condition,
                left,
                right,
                left.jsonPath
              );
            } else {
              const right = evalExprToJsonPathOrLiteral(expr.right);
              const addResult =
                expr.op === "+="
                  ? this.plus(left, right)
                  : this.minus(left, right);

              if (ASLGraph.isStateOrSubState(addResult)) {
                addState(addResult);
              }

              const addResultOut = ASLGraph.isStateOrSubState(addResult)
                ? addResult.output
                : addResult;

              // x = result
              addState(
                this.assignValue(undefined, addResultOut, left.jsonPath)
              );

              // return the result, not the reference to the left. Rhe reference to the left may change later. (const x = (b += "a"))
              return addResultOut;
            }
          }
        );
      }
      return assertNever(expr.op);
    } else if (isAwaitExpr(expr)) {
      return this.eval(expr.expr);
    } else if (isTypeOfExpr(expr)) {
      return this.evalExpr(expr.expr, (exprOutput) => {
        if (ASLGraph.isLiteralValue(exprOutput)) {
          return {
            value: typeof exprOutput.value,
            containsJsonPath: false,
          };
        } else if (ASLGraph.isConditionOutput(exprOutput)) {
          return {
            value: "boolean",
            containsJsonPath: false,
          };
        }

        const tempHeap = this.newHeapVariable();

        return {
          startState: "choose",
          states: {
            choose: {
              Type: "Choice",
              Choices: [
                {
                  ...ASL.and(
                    ASL.isPresent(exprOutput.jsonPath),
                    ASL.isString(exprOutput.jsonPath)
                  ),
                  Next: "string",
                },
                {
                  ...ASL.and(
                    ASL.isPresent(exprOutput.jsonPath),
                    ASL.isBoolean(exprOutput.jsonPath)
                  ),
                  Next: "boolean",
                },
                {
                  ...ASL.and(
                    ASL.isPresent(exprOutput.jsonPath),
                    ASL.isNumeric(exprOutput.jsonPath)
                  ),
                  Next: "number",
                },
                {
                  ...ASL.isPresent(exprOutput.jsonPath),
                  Next: "object",
                },
              ],
              Default: "undefined",
            },
            string: {
              Type: "Pass",
              Result: "string",
              ResultPath: tempHeap,
              Next: ASLGraph.DeferNext,
            },
            boolean: {
              Type: "Pass",
              Result: "boolean",
              ResultPath: tempHeap,
              Next: ASLGraph.DeferNext,
            },
            number: {
              Type: "Pass",
              Result: "number",
              ResultPath: tempHeap,
              Next: ASLGraph.DeferNext,
            },
            object: {
              Type: "Pass",
              Result: "object",
              ResultPath: tempHeap,
              Next: ASLGraph.DeferNext,
            },
            undefined: {
              Type: "Pass",
              Result: "undefined",
              ResultPath: tempHeap,
              Next: ASLGraph.DeferNext,
            },
          },
          output: {
            jsonPath: tempHeap,
          },
        };
      });
    } else if (isConditionExpr(expr)) {
      return this.evalExpr(expr.when, (output) => {
        /* use `this.eval` instead of the evalContext's evalExpr so that the states for left and right are not hoisted before the condition is evaluated
           statesForCondition
           Choice(cond)
              true ->
                states for left
                left
              false ->
                states for false
                right
            return output of left or right
        */
        const left = this.eval(expr.then);
        const right = this.eval(expr._else);

        return this.conditionState(
          expr,
          ASLGraph.isTruthyOutput(output),
          left,
          right
        );
      });
    } else if (isParenthesizedExpr(expr)) {
      return this.eval(expr.expr);
    }
    throw new Error(`cannot eval expression kind '${expr.kindName}'`);
  }

  /**
   * Returns an object containing Pass/Task parameters values to clone the current lexical scope into
   * another scope, like a Map state.
   *
   * ```ts
   * {
   *    'a.$': '$.a'
   * }
   * ```
   */
  public cloneLexicalScopeParameters(
    node: FunctionlessNode
  ): Record<string, string> {
    const parentStmt = isStmt(node) ? node : node.findParent(isStmt);
    const variableReferences =
      (parentStmt?.prev ?? parentStmt?.parent)?.getLexicalScope() ??
      new Map<string, BindingDecl>();
    return {
      [`${FUNCTIONLESS_CONTEXT_NAME}.$`]: FUNCTIONLESS_CONTEXT_JSON_PATH,
      ...Object.fromEntries(
        Array.from(variableReferences.values())
          // the context parameter is resolved by using `$$.*` anywhere in the machine, it never needs to be passed in.
          .filter((decl) => decl !== this.contextParameter)
          .map((decl) =>
            // assume there is an identifier name if it is in the lexical scope
            this.getDeclarationName(decl as BindingDecl & { name: Identifier })
          )
          .map((name) => [`${name}.$`, `$.${name}`])
      ),
    };
  }

  /**
   * Evaluates any expression to a string.
   *
   * https://262.ecma-international.org/5.1/#sec-9.8
   */
  public evalToString(expr?: Expr): ASLGraph.NodeResults {
    if (!expr) {
      return {
        // String()
        value: "",
        containsJsonPath: false,
      };
    }
    return this.evalExprToJsonPathOrLiteral(
      expr,
      (output, { normalizeOutputToJsonPath }) => {
        // String(var)
        if (ASLGraph.isJsonPath(output)) {
          return this.jsonPathValueToString(normalizeOutputToJsonPath());
        } else {
          // String(1)
          return {
            value: String(output.value),
            containsJsonPath: false,
          };
        }
      }
    );
  }

  /**
   * Implements the logic of unary `-` on an expression.
   *
   * First the value is converted to a number and then it is negated.
   */
  public negateExpr(expr: Expr) {
    return this.evalContext(expr, ({ addState }) => {
      const number = this.evalToNumber(expr);

      if (ASLGraph.isStateOrSubState(number)) {
        addState(number);
      }
      const numberOutput = ASLGraph.isLiteralValue(number)
        ? number
        : number.output;

      return this.negateJsonPathOrLiteralValue(numberOutput);
    });
  }

  /**
   * Invert the numeric value of a reference.
   *
   * Assumes that a jsonPath is a number or null.
   */
  public negateJsonPathOrLiteralValue(
    output: ASLGraph.JsonPath | ASLGraph.LiteralValue<number | null>,
    node?: FunctionlessNode
  ):
    | ASLGraph.LiteralValue<number | null>
    | (ASLGraph.OutputSubState & { output: ASLGraph.JsonPath }) {
    if (ASLGraph.isLiteralValue(output)) {
      if (output.value === null) {
        return output;
      }
      return ASLGraph.literalValue(-output.value);
    } else {
      const heap = this.newHeapVariable();
      // we know we have a number or null (NaN) because that is what evalToNumber does.
      // however, we do not know if the value is negative or positive and we cannot
      // directly negate a number.
      return {
        startState: "check",
        node: node,
        states: {
          check: {
            Type: "Choice",
            Choices: [
              { ...ASL.isNull(output.jsonPath), Next: "NaN" },
              {
                ...ASL.numericLessThan(output.jsonPath, 0),
                Next: "negative",
              },
            ],
            Default: "positive",
          },
          NaN: this.assignValue(
            undefined,
            ASLGraph.jsonPath(this.context.null),
            `${heap}.num`
          ),
          // turn a negative number into a positive number -10 => 10
          negative: ASLGraph.joinSubStates(
            undefined,
            // FIXME: This is split into two steps because step functions has a bug that string split
            //        cannot be used as the first argument of array get item.
            //        If they ever fix that... move the stringSplit into the arrayGetItem.
            ASLGraph.assignJsonPathOrIntrinsic(
              // split the string on the `-`: ["", "10"]
              ASLGraph.intrinsicStringSplit(
                // turn number into a string: -10 => "-10"
                ASLGraph.intrinsicFormat("{}", output),
                ASLGraph.literalValue("-")
              ),
              heap,
              "num"
            ),
            ASLGraph.assignJsonPathOrIntrinsic(
              // turn the string fragment back to a number: 10
              ASLGraph.intrinsicStringToJson(
                // take the right of the value (the number): "10"
                ASLGraph.intrinsicArrayGetItem(
                  ASLGraph.jsonPath(heap, "num"),
                  0
                )
              ),
              heap,
              "num"
            )
          )!,
          positive: ASLGraph.assignJsonPathOrIntrinsic(
            ASLGraph.intrinsicStringToJson(
              ASLGraph.intrinsicFormat("-{}", output)
            ),
            heap,
            "num"
          ),
        },
        output: ASLGraph.jsonPath(heap, "num"),
      };
    }
  }

  /**
   * Evaluates any jsonPath value to a string.
   *
   * https://262.ecma-international.org/5.1/#sec-9.8
   *
   * @returns jsonPath: {resultPath}.str
   *
   * Caveat: Unlike the ECMA spec, objects and arrays will be stringified with JsonToString.
   * 1. To avoid the complexity of a recursive array join for arrays.
   * 2. It is impossible to tell an empty object from an empty array.
   */
  public jsonPathValueToString(
    jsonPath: ASLGraph.JsonPath,
    resultPath?: string
  ): ASLGraph.OutputSubState {
    const heap = resultPath ?? this.newHeapVariable();

    return {
      startState: "checkString",
      states: {
        // String("") => ""
        checkString: {
          Type: "Choice",
          Choices: [{ ...ASL.isString(jsonPath.jsonPath), Next: "assign" }],
          Default: "format",
        },
        format: ASLGraph.assignJsonPathOrIntrinsic(
          ASLGraph.intrinsicJsonToString(jsonPath),
          heap,
          "str"
        ),
        // since this state can only output a single json path value,
        // assign the input json path to the expected output path
        assign: {
          Type: "Pass",
          InputPath: jsonPath.jsonPath,
          ResultPath: `${heap}.str`,
          Next: ASLGraph.DeferNext,
        },
      },
      output: {
        jsonPath: `${heap}.str`,
      },
    };
  }

  /**
   * Evaluates any expression to a number. When the number cannot be converted, returns `null`.
   *
   * https://262.ecma-international.org/5.1/#sec-9.3
   */
  public evalToNumber(expr?: Expr) {
    if (!expr) {
      return ASLGraph.literalValue(0);
    }
    return this.evalExpr(expr, (output) => {
      if (ASLGraph.isConditionOutput(output)) {
        const temp = this.newHeapVariable();
        return this.conditionState(
          expr,
          output.condition,
          {
            Type: "Pass" as const,
            Result: 1,
            Next: ASLGraph.DeferNext,
            ResultPath: temp,
            output: { jsonPath: temp },
          },
          {
            Type: "Pass" as const,
            Result: 0,
            Next: ASLGraph.DeferNext,
            ResultPath: temp,
            output: { jsonPath: temp },
          },
          temp
        );
      } else if (ASLGraph.isJsonPath(output)) {
        return this.jsonPathValueToNumber(output);
      } else {
        return ASLGraph.literalValue(
          typeof output.value === "number"
            ? (output.value as number)
            : Number.isNaN(output.value)
            ? // Treat NaN as Null as we do not support special symbols.
              null
            : Number(output.value)
        );
      }
    });
  }

  /**
   * Evaluates any jsonPath value to a number.
   *
   * https://262.ecma-international.org/5.1/#sec-9.3
   *
   * @returns jsonPath: {resultPath}.num
   */
  public jsonPathValueToNumber(
    jsonPath: ASLGraph.JsonPath,
    resultPath?: string
  ): ASLGraph.OutputSubState & { output: ASLGraph.JsonPath } {
    const heap = resultPath ?? this.newHeapVariable();
    return {
      startState: "check",
      states: {
        // string to json only supports strings!
        check: {
          Type: "Choice",
          Choices: [
            // Number(undefined) => NaN
            { ...ASL.isNotPresent(jsonPath.jsonPath), Next: "null" },
            // Number("") => 0
            {
              ...ASL.and(
                ASL.isString(jsonPath.jsonPath),
                ASL.stringEquals(jsonPath.jsonPath, "")
              ),
              Next: "zero",
            },
            // Number(null) => 0
            { ...ASL.isNull(jsonPath.jsonPath), Next: "zero" },
            // Number("1") => 1
            { ...ASL.isString(jsonPath.jsonPath), Next: "format" },
            // Number(1) => 1
            { ...ASL.isNumeric(jsonPath.jsonPath), Next: "assign" },
            // Number(true) => 1
            {
              ...ASL.and(
                ASL.isBoolean(jsonPath.jsonPath),
                ASL.booleanEquals(jsonPath.jsonPath, true)
              ),
              Next: "one",
            },
            // Number(false) => 0
            {
              ...ASL.and(
                ASL.isBoolean(jsonPath.jsonPath),
                ASL.booleanEquals(jsonPath.jsonPath, false)
              ),
              Next: "zero",
            },
          ],
          // Number(null/{}/[]) => NaN
          Default: "null",
        },
        format: ASLGraph.assignJsonPathOrIntrinsic(
          ASLGraph.intrinsicStringToJson(jsonPath),
          heap,
          "num",
          "checkStringOutput"
        ),
        // Number("true") => NaN
        checkStringOutput: {
          Type: "Choice",
          Choices: [
            { ...ASL.isNumeric(`${heap}.num`), Next: ASLGraph.DeferNext },
          ],
          Default: "null",
        },
        assign: this.assignValue(undefined, jsonPath, `${heap}.num`),
        one: this.assignValue(
          undefined,
          ASLGraph.literalValue(1),
          `${heap}.num`
        ),
        zero: this.assignValue(
          undefined,
          ASLGraph.literalValue(0),
          `${heap}.num`
        ),
        // Treat NaN as Null as we do not support special symbols.
        null: this.assignValue(
          undefined,
          ASLGraph.jsonPath(this.context.null),
          `${heap}.num`
        ),
      },
      output: ASLGraph.jsonPath(heap, "num"),
    };
  }

  public plus(
    leftOut: ASLGraph.JsonPath | ASLGraph.LiteralValue,
    rightOut: ASLGraph.JsonPath | ASLGraph.LiteralValue,
    node?: FunctionlessNode
  ) {
    if (
      ASLGraph.isLiteralString(leftOut) ||
      ASLGraph.isLiteralString(rightOut)
    ) {
      // one is a string literal, string concat
      return this.stringConcat(leftOut, rightOut);
    } else if (
      ASLGraph.isLiteralValue(leftOut) &&
      ASLGraph.isLiteralValue(rightOut)
    ) {
      // both are literals and neither are strings, numeric add
      return this.numericAdd(leftOut, rightOut);
    } else {
      // at least one json path, use runtime condition state to determine which path to take
      return this.conditionState(
        node,
        ASL.or(
          // are at least one of the json path values a string? string concat
          ASLGraph.isJsonPath(leftOut)
            ? ASL.isString(leftOut.jsonPath)
            : undefined,
          ASLGraph.isJsonPath(rightOut)
            ? ASL.isString(rightOut.jsonPath)
            : undefined
        ),
        // either are strings, concat
        this.stringConcat(leftOut, rightOut),
        this.numericAdd(leftOut, rightOut)
      );
    }
  }

  public minus(
    leftOut: ASLGraph.JsonPath | ASLGraph.LiteralValue,
    rightOut: ASLGraph.JsonPath | ASLGraph.LiteralValue
  ) {
    return this.evalContext(undefined, ({ addState }) => {
      // change literal value or reference value to a number
      const leftNumber = ASLGraph.isLiteralValue(leftOut)
        ? ASLGraph.literalValue(Number(leftOut.value))
        : this.jsonPathValueToNumber(leftOut);

      // NaN - anything = NaN - we use null for NaN
      if (
        ASLGraph.isLiteralNumber(leftNumber) &&
        Number.isNaN(leftNumber.value)
      ) {
        return ASLGraph.literalValue(null);
      }

      // if there are states required to make a number, add them
      if (ASLGraph.isStateOrSubState(leftNumber)) {
        addState(leftNumber);
      }

      const leftNumberOut = ASLGraph.isLiteralValue(leftNumber)
        ? leftNumber
        : leftNumber.output;

      // change literal value or reference value to a number
      const rightNumber = ASLGraph.isLiteralValue(rightOut)
        ? ASLGraph.literalValue(Number(rightOut.value))
        : this.jsonPathValueToNumber(rightOut);

      // if there are states required to make a number, add them
      if (ASLGraph.isStateOrSubState(rightNumber)) {
        addState(rightNumber);
      }

      const rightNumberOut = ASLGraph.isLiteralValue(rightNumber)
        ? rightNumber
        : rightNumber.output;

      // we can only add in ASL, so negate the right side value (a - a) => (a + -a)
      const negatedRight = this.negateJsonPathOrLiteralValue(rightNumberOut);

      if (ASLGraph.isStateOrSubState(negatedRight)) {
        addState(negatedRight);
      }

      const negatedRightOut = ASLGraph.isLiteralValue(negatedRight)
        ? negatedRight
        : negatedRight.output;

      // Anything - NaN = NaN
      if (ASLGraph.isLiteralNull(negatedRightOut)) {
        return negatedRightOut;
      }

      return this.assignJsonPathOrIntrinsic(
        ASLGraph.intrinsicMathAdd(
          leftNumberOut,
          negatedRightOut as ASLGraph.LiteralValue<number>
        )
      );
    });
  }

  /**
   * Performs addition on any two value, coercing to a number as needed.
   */
  public numericAdd(
    leftOut: ASLGraph.JsonPath | ASLGraph.LiteralValue,
    rightOut: ASLGraph.JsonPath | ASLGraph.LiteralValue
  ): ASLGraph.NodeResults {
    const heap = this.newHeapVariable();
    if (ASLGraph.isLiteralValue(leftOut) && ASLGraph.isLiteralValue(rightOut)) {
      return ASLGraph.literalValue(
        Number(leftOut.value) + Number(rightOut.value)
      );
    } else {
      return {
        ...ASLGraph.joinSubStates(
          undefined,
          ASLGraph.isLiteralValue(leftOut)
            ? undefined
            : this.jsonPathValueToNumber(leftOut, `${heap}.str.left`),
          ASLGraph.isLiteralValue(rightOut)
            ? undefined
            : this.jsonPathValueToNumber(rightOut, `${heap}.str.right`),
          ASLGraph.assignJsonPathOrIntrinsic(
            ASLGraph.intrinsicMathAdd(
              ASLGraph.isLiteralValue(leftOut)
                ? ASLGraph.literalValue(Number(leftOut.value))
                : ASLGraph.jsonPath(heap, "str.left.num"),
              ASLGraph.isLiteralValue(rightOut)
                ? ASLGraph.literalValue(Number(rightOut.value))
                : ASLGraph.jsonPath(heap, "str.right.num")
            ),
            heap,
            "str"
          )
        )!,
        output: ASLGraph.jsonPath(heap, "str"),
      };
    }
  }

  /**
   * Preforms a string concat on any two values, coercing to a string as needed.
   */
  public stringConcat(
    leftOut: ASLGraph.JsonPath | ASLGraph.LiteralValue,
    rightOut: ASLGraph.JsonPath | ASLGraph.LiteralValue
  ): ASLGraph.NodeResults {
    const heap = this.newHeapVariable();
    if (ASLGraph.isLiteralValue(leftOut) && ASLGraph.isLiteralValue(rightOut)) {
      return ASLGraph.literalValue(`${leftOut.value}${rightOut.value}`);
    } else {
      return {
        ...ASLGraph.joinSubStates(
          undefined,
          ASLGraph.isLiteralValue(leftOut)
            ? undefined
            : this.jsonPathValueToString(leftOut, `${heap}.str.left`),
          ASLGraph.isLiteralValue(rightOut)
            ? undefined
            : this.jsonPathValueToString(rightOut, `${heap}.str.right`),
          ASLGraph.assignJsonPathOrIntrinsic(
            ASLGraph.intrinsicFormat(
              "{}{}",
              ASLGraph.isLiteralValue(leftOut)
                ? ASLGraph.literalValue(String(leftOut.value))
                : ASLGraph.jsonPath(heap, "str.left.str"),
              ASLGraph.isLiteralValue(rightOut)
                ? ASLGraph.literalValue(String(rightOut.value))
                : ASLGraph.jsonPath(heap, "str.right.str")
            ),
            heap,
            "str"
          )
        )!,
        output: ASLGraph.jsonPath(heap, "str"),
      };
    }
  }

  /**
   * Helper that generates an {@link ASLGraph.OutputState} which returns null.
   */
  public stateWithVoidOutput(
    state: State | ASLGraph.SubState
  ): ASLGraph.OutputSubState | ASLGraph.OutputState {
    return {
      ...state,
      output: {
        jsonPath: this.context.null,
      },
    };
  }

  /**
   * Helper that generates an {@link ASLGraph.OutputState} which returns a value to a temporary location.
   */
  public stateWithHeapOutput(
    state: Exclude<ASLGraph.NodeState, Choice | Fail | Succeed | Wait>,
    node?: FunctionlessNode
  ): ASLGraph.NodeState & { output: ASLGraph.JsonPath } {
    const tempHeap = this.newHeapVariable();
    return {
      ...state,
      node,
      ResultPath: tempHeap,
      output: {
        jsonPath: tempHeap,
      },
    };
  }

  /**
   * Helper that generates a {@link Pass} state to assign a single jsonPath or intrinsic to
   * an output location.
   *
   * ```ts
   * assignJsonPathOrIntrinsic("out", "States.Array(1,2,3)");
   * ```
   *
   * =>
   *
   * ```ts
   * {
   *    "Type": "Pass",
   *    "Parameters": {
   *       "out.$": "State.Array(1,2,3)"
   *    },
   *    "Next": ASLGraph.DeferNext,
   *    "ResultPath": "$.someTempLocation",
   *    "output": { "jsonPath": "$.someTempLocation.out" }
   * }
   * ```
   *
   * @param jsonPathOrIntrinsic - json path (ex: $.var) or instrinsic function (ex: States.Array) to place into the output.
   */
  public assignJsonPathOrIntrinsic(
    jsonPathOrIntrinsic: ASLGraph.IntrinsicFunction | ASLGraph.JsonPath,
    propertyName: string = "out",
    next: string = ASLGraph.DeferNext,
    node?: FunctionlessNode
  ) {
    const tempHeap = this.newHeapVariable();
    return ASLGraph.assignJsonPathOrIntrinsic(
      jsonPathOrIntrinsic,
      tempHeap,
      propertyName,
      next,
      node
    );
  }

  /**
   * When the condition is true, executes the true states and assigns the left output to a temp variable.
   * When the condition is false, executes the true states and assigns the right out to a temp variable.
   *
   * @param trueState - states to execute when the condition is true. Default: returns true
   * @param falseState - states to execute when the condition is false. Default: returns false
   *
   * @returns a {@link ASLGraph.OutputSubState} that executes true when the value is true and false when the value is false.
   */
  public conditionState(
    node: FunctionlessNode | undefined,
    cond: Condition,
    trueState?: ASLGraph.NodeResults,
    falseState?: ASLGraph.NodeResults,
    outputJsonPath?: string
  ): ASLGraph.OutputSubState & { output: ASLGraph.JsonPath } {
    const trueOutput: ASLGraph.Output = trueState
      ? ASLGraph.getAslStateOutput(trueState)
      : { value: true, containsJsonPath: false };
    const falseOutput: ASLGraph.Output = falseState
      ? ASLGraph.getAslStateOutput(falseState)
      : { value: false, containsJsonPath: false };
    const tempHeap = outputJsonPath ?? this.newHeapVariable();
    return {
      node,
      startState: "default",
      states: {
        default: {
          Type: "Choice",
          Choices: [{ ...cond, Next: "true" }],
          Default: "false",
        },
        true: ASLGraph.joinSubStates(
          ASLGraph.isStateOrSubState(trueState) ? trueState.node : undefined,
          trueState,
          ASLGraph.isJsonPath(trueOutput) && trueOutput.jsonPath === tempHeap
            ? { Type: "Pass", Next: ASLGraph.DeferNext }
            : this.assignValue(undefined, trueOutput, tempHeap)
        )!,
        false: ASLGraph.joinSubStates(
          ASLGraph.isStateOrSubState(falseState) ? falseState.node : undefined,
          falseState,
          ASLGraph.isJsonPath(falseOutput) && falseOutput.jsonPath === tempHeap
            ? { Type: "Pass", Next: ASLGraph.DeferNext }
            : this.assignValue(undefined, falseOutput, tempHeap)
        )!,
      },
      output: {
        jsonPath: tempHeap,
      },
    };
  }

  /**
   * Mutable heap counter.
   */
  private heapCounter = 0;

  /**
   * returns an in order unique memory location in the form `$.heap[id]`
   * TODO: make this contextual - https://github.com/functionless/functionless/issues/321
   */
  public newHeapVariable() {
    return `$.${this.newHeapVariableName()}`;
  }

  /**
   * returns an in order unique memory location in the form `heap[id]`
   * TODO: make this contextual - https://github.com/functionless/functionless/issues/321
   */
  public newHeapVariableName() {
    return `heap${this.heapCounter++}`;
  }

  /**
   * Find the transition edge from this {@link node} to the State which will handle
   * the error.
   *
   * @param node
   * @returns `undefined` if the error is terminal, otherwise a Next, ResultPath
   */
  public throw(node: FunctionlessNode):
    | {
        /**
         * Name of the state to transition to.
         */
        Next: string;
        /**
         * JSON Path to store the the error payload.
         */
        ResultPath: string | null;
      }
    | undefined {
    // detect the immediate for-loop closure surrounding this throw statement
    // because of how step function's Catch feature works, we need to check if the try
    // is inside or outside the closure
    const mapOrParallelClosure = node.findParent(isFunctionLike);

    // catchClause or finallyBlock that will run upon throwing this error
    const catchOrFinally = node.throw();
    if (catchOrFinally === undefined) {
      // error is terminal
      return undefined;
    } else if (
      mapOrParallelClosure === undefined ||
      // TODO: this implementation is specific to the current state. Try/Catch/Finally needs to be generalize based on the generated ASL, not the AST.
      // https://github.com/functionless/functionless/issues/385
      (isArgument(mapOrParallelClosure.parent) &&
        isCallExpr(mapOrParallelClosure.parent.parent) &&
        isPropAccessExpr(mapOrParallelClosure.parent.parent.expr) &&
        (mapOrParallelClosure.parent.parent.expr.name.name === "map" ||
          mapOrParallelClosure.parent.parent.expr.name.name === "filter" ||
          mapOrParallelClosure.parent.parent.expr.name.name === "forEach") &&
        !isReferenceExpr(mapOrParallelClosure.parent.parent.expr.expr)) ||
      mapOrParallelClosure.contains(catchOrFinally)
    ) {
      // the catch/finally handler is nearer than the surrounding Map/Parallel State
      return {
        Next: ASL.CatchState,
        ResultPath: (() => {
          if (
            (isCatchClause(catchOrFinally) && catchOrFinally.variableDecl) ||
            (isBlockStmt(catchOrFinally) &&
              catchOrFinally.isFinallyBlock() &&
              catchOrFinally.parent.catchClause &&
              canThrow(catchOrFinally.parent.catchClause) &&
              // we only store the error thrown from the catchClause if the finallyBlock is not terminal
              // by terminal, we mean that every branch returns a value - meaning that the re-throw
              // behavior of a finally will never be triggered - the return within the finally intercepts it
              !catchOrFinally.isTerminal())
          ) {
            return `$.${this.generatedNames.generateOrGet(catchOrFinally)}`;
          } else {
            return null;
          }
        })(),
      };
    } else {
      // the Map/Parallel tasks are closer than the catch/finally, so we use a Fail State
      // to terminate the Map/Parallel and delegate the propagation of the error to the
      // Map/Parallel state
      return undefined;
    }
  }

  /**
   * Process a `array.slice()` expression and output the jsonPath or constant value.
   */
  private sliceToStateOutput(
    expr: CallExpr & { expr: PropAccessExpr }
  ): ASLGraph.NodeResults {
    const [startArg, endArg] = expr.args;
    return this.subArray(expr, expr.expr.expr, startArg?.expr, endArg?.expr);
  }

  /**
   * Turns a call to `.join` on an array into a {@link ASLGraph.SubState}.
   *
   * If both the array and the separator argument are constant, just run .join and return the results.
   *
   * Otherwise, create a state machine that iterates over all elements of the array at runtime and creates a new
   * string with the separator between elements.
   */
  private joinToStateOutput(
    expr: CallExpr & { expr: PropAccessExpr }
  ): ASLGraph.NodeResults {
    return this.evalContext(
      expr,
      ({
        evalExpr,
        evalExprToJsonPathOrLiteral,
        normalizeOutputToJsonPath,
      }) => {
        const separatorArg = expr.args[0]?.expr;
        const valueOutput = evalExpr(expr.expr.expr);
        const separatorOutput = separatorArg
          ? evalExprToJsonPathOrLiteral(separatorArg)
          : undefined;
        const separator =
          separatorOutput &&
          (ASLGraph.isJsonPath(separatorOutput) ||
            separatorOutput.value !== undefined)
            ? separatorOutput
            : // default to `,`
              { value: ",", containsJsonPath: false };

        if (
          ASLGraph.isConditionOutput(valueOutput) ||
          (ASLGraph.isLiteralValue(valueOutput) &&
            !Array.isArray(valueOutput.value))
        ) {
          throw new SynthError(
            ErrorCodes.Unexpected_Error,
            "Expected join to be performed on a variable or array constant"
          );
        }

        if (
          ASLGraph.isLiteralValue(separator) &&
          typeof separator.value !== "string"
        ) {
          throw new SynthError(
            ErrorCodes.Unexpected_Error,
            "Expected join separator to be missing, undefined, a string, or a variable"
          );
        }

        // both are constants, evaluate them here.
        if (
          ASLGraph.isLiteralValue(valueOutput) &&
          ASLGraph.isLiteralValue(separator)
        ) {
          return {
            value: (<any[]>valueOutput.value).join(<string>separator.value),
            containsJsonPath: false,
          };
        }

        const { jsonPath: valueJsonPath } =
          normalizeOutputToJsonPath(valueOutput);

        const arrayPath = this.newHeapVariable();
        const resultVariable = this.newHeapVariable();

        const formatState = this.jsonPathValueToString({
          jsonPath: "$.item",
        });

        return {
          startState: "initArray",
          states: {
            // format each of the values using toString logic
            // https://262.ecma-international.org/5.1/#sec-9.8
            initArray: {
              Type: "Map",
              ItemsPath: valueJsonPath,
              Parameters: {
                "item.$": "$$.Map.Item.Value",
              },
              Iterator: this.aslGraphToStates({
                startState: "format",
                states: {
                  format: ASLGraph.updateDeferredNextStates(
                    { Next: "assign" },
                    formatState
                  ),
                  assign: this.assignValue(undefined, formatState.output, "$"),
                },
              }),
              ResultPath: arrayPath,
              Next: "hasNext",
            },
            hasNext: {
              Type: "Choice",
              Choices: [
                // not initialized and has next: init as first element
                {
                  ...ASL.and(
                    ASL.isPresent(`${arrayPath}[0]`),
                    ASL.not(ASL.isPresent(resultVariable))
                  ),
                  Next: "initValue",
                },
                // not initialized, but the array is empty
                {
                  ...ASL.and(
                    ASL.isNotPresent(`${arrayPath}[0]`),
                    ASL.isNotPresent(resultVariable)
                  ),
                  Next: "returnEmpty",
                },
                // already initialized, there are items left
                { ...ASL.isPresent(`${arrayPath}[0]`), Next: "append" },
              ],
              // nothing left to do, return the accumulated string
              Default: "done",
            },
            // place the first value on the output
            initValue: {
              Type: "Pass",
              InputPath: `${arrayPath}[0]`,
              ResultPath: `${resultVariable}.string`,
              // update the temp array
              Next: "tail",
            },
            // append the current string to the separator and the head of the array
            append: ASLGraph.assignJsonPathOrIntrinsic(
              ASLGraph.isJsonPath(separator)
                ? ASLGraph.intrinsicFormat(
                    "{}{}{}",
                    ASLGraph.jsonPath(resultVariable, "string"),
                    separator,
                    ASLGraph.jsonPath(`${arrayPath}[0]`)
                  )
                : ASLGraph.intrinsicFormat(
                    `{}${separator.value}{}`,
                    ASLGraph.jsonPath(resultVariable, "string"),
                    ASLGraph.jsonPath(`${arrayPath}[0]`)
                  ),
              resultVariable,
              "string",
              "tail"
            ),
            // update the temp array and then check to see if there is more to do
            tail: {
              Type: "Pass",
              InputPath: `${arrayPath}[1:]`,
              ResultPath: arrayPath,
              Next: "hasNext", // restart by checking for items after tail
            },
            // empty array, return `''`
            returnEmpty: {
              Type: "Pass",
              Result: "",
              ResultPath: `${resultVariable}.string`,
              Next: ASLGraph.DeferNext,
            },
            // nothing left to do, this state will likely get optimized out, but it gives us a target
            done: {
              Type: "Pass",
              Next: ASLGraph.DeferNext,
            },
          },
          output: {
            jsonPath: `${resultVariable}.string`,
          },
        };
      }
    );
  }

  private filterToStateOutput(
    expr: CallExpr & { expr: PropAccessExpr }
  ): ASLGraph.NodeResults {
    const predicate = expr.args[0]?.expr;
    if (!isFunctionLike(predicate)) {
      throw new SynthError(
        ErrorCodes.Invalid_Input,
        `the 'predicate' argument of filter must be a function or arrow expression, found: ${predicate?.kindName}`
      );
    }

    return this.evalExprToJsonPath(expr.expr.expr, (leftOutput) => {
      if (
        ASLGraph.isLiteralValue(leftOutput) &&
        !Array.isArray(leftOutput.value)
      ) {
        throw new SynthError(
          ErrorCodes.Unexpected_Error,
          "Expected filter to be called on a literal array or reference to one."
        );
      }

      return (
        this.filterToJsonPath(leftOutput, predicate) ?? {
          node: expr,
          ...this.filterToASLGraph(leftOutput, predicate),
        }
      );
    });
  }

  /**
   * Attempt to compile filter to JSONPath. If possible, this is the most efficient way to filter.
   *
   * When not possible, undefined is returned.
   */
  private filterToJsonPath(
    valueJsonPath: ASLGraph.JsonPath,
    predicate: FunctionExpr | ArrowFunctionExpr
  ): ASLGraph.JsonPath | undefined {
    const stmt = predicate.body.statements[0];
    if (
      stmt === undefined ||
      !isReturnStmt(stmt) ||
      predicate.body.statements.length !== 1
    ) {
      return undefined;
    }

    const toFilterCondition = (expr: Expr): string | undefined => {
      const constant = evalToConstant(expr);
      if (constant) {
        if (typeof constant.constant === "string") {
          // strings are wrapped with '' in the filter expression.
          // Escape existing quotes to avoid issues.
          return `'${constant.constant.replace(/'/g, "\\'")}'`;
        }
        if (
          typeof constant.constant === "object" &&
          constant.constant !== null
        ) {
          // try to compile with ASLGraph instead
          return undefined;
        } else {
          return `${constant.constant}`;
        }
      } else if (isBinaryExpr(expr)) {
        const left = toFilterCondition(expr.left);
        const right = toFilterCondition(expr.right);
        return left && right
          ? `${left}${
              expr.op === "===" ? "==" : expr.op === "!==" ? "!=" : expr.op
            }${right}`
          : undefined;
      } else if (isUnaryExpr(expr)) {
        const right = toFilterCondition(expr.expr);
        return right ? `${expr.op}${right}` : undefined;
      } else if (isIdentifier(expr)) {
        const ref = expr.lookup();
        if (ref === undefined) {
          // try to compile with ASLGraph instead
          return undefined;
        }
        if (
          (isParameterDecl(ref) || isBindingElem(ref)) &&
          ref.findParent(
            (parent): parent is typeof predicate => parent === predicate
          )
        ) {
          return resolveRef(ref);
        } else {
          return `$.${(<Identifier>expr).name}`;
        }
        function resolveRef(
          ref: ParameterDecl | BindingElem
        ): string | undefined {
          if (isParameterDecl(ref)) {
            if (ref === predicate.parameters[0]) {
              return "@";
            }
            return undefined;
          } else {
            const value = resolveRef(
              ref.parent.parent as unknown as ParameterDecl | BindingElem
            );

            // if undefined, try to compile with ASL Graph
            if (!value) {
              return value;
            }

            if (isArrayBinding(ref.parent)) {
              return `${value}[${ref.parent.bindings.indexOf(ref)}]`;
            }

            const propName = ref.propertyName
              ? isIdentifier(ref.propertyName)
                ? ref.propertyName.name
                : isStringLiteralExpr(ref.propertyName)
                ? ref.propertyName.value
                : evalToConstant(ref.propertyName)?.constant
              : isIdentifier(ref.name)
              ? ref.name.name
              : undefined;

            if (!propName) {
              // step function does not support variable property accessors
              // this will probably fail in the filter to ASLGraph implementation too
              // however, lets let ASLGraph try and fail if needed.
              return undefined;
            }

            return `${value}['${propName}']`;
          }
        }
      } else if (isPropAccessExpr(expr)) {
        const value = toFilterCondition(expr.expr);
        return value ? `${value}.${expr.name.name}` : undefined;
      } else if (isElementAccessExpr(expr)) {
        const field = this.getElementAccessConstant(
          ASLGraph.getAslStateOutput(this.eval(expr.element))
        );

        const value = toFilterCondition(expr.expr);

        return value
          ? `${value}[${typeof field === "number" ? field : `'${field}'`}]`
          : undefined;
      }

      // try to compile with ASLGraph instead
      return undefined;
    };

    const expression = toFilterCondition(
      stmt.expr ?? stmt.fork(new NullLiteralExpr(stmt.span))
    );
    return expression
      ? {
          jsonPath: `${valueJsonPath.jsonPath}[?(${expression})]`,
        }
      : undefined;
  }

  /**
   * filter an array using ASLGraph. Should support any logic that returns a boolean already supported by Functionless Step Functions.
   *
   * Note: If possible, try to use {@link filterToJsonPath} as it introduces no new state transitions.
   */
  private filterToASLGraph(
    valueJsonPath: ASLGraph.JsonPath,
    predicate: FunctionExpr | ArrowFunctionExpr
  ): ASLGraph.OutputSubState {
    return this.iterateArrayMethod(
      predicate,
      valueJsonPath.jsonPath,
      false,
      // initialize the arrStr to [null
      {
        arrStr: "[null",
      },
      // customize the default result handling logic by:
      // 1. check the returned predicate (iterationResult)
      // 2. if true, append the original item (itemJsonPath) to the `arrStr` initialized above.
      // 3. return over the `resultPath`
      ({
        iterationResult,
        itemJsonPath,
        tailStateName,
        tailJsonPath,
        tailTarget,
        workingSpaceJsonPath,
      }) => {
        return {
          startState: "checkPredicate",
          states: {
            checkPredicate: {
              Type: "Choice",
              Choices: [
                { ...ASL.isTruthy(iterationResult), Next: "predicateTrue" },
              ],
              Default: tailStateName,
            },
            // tail and append
            predicateTrue: {
              Type: "Pass",
              Parameters: {
                // tail
                [`${tailTarget}.$`]: tailJsonPath,
                // const arrStr = `${arrStr},${JSON.stringify(arr[0])}`;
                "arrStr.$": ASLGraph.renderIntrinsicFunction(
                  ASLGraph.intrinsicFormat(
                    "{},{}",
                    ASLGraph.jsonPath(workingSpaceJsonPath, "arrStr"),
                    ASLGraph.intrinsicJsonToString(
                      ASLGraph.jsonPath(itemJsonPath)
                    )
                  )
                ),
              },
              // write over the current working space
              ResultPath: workingSpaceJsonPath,
              Next: ASLGraph.DeferNext,
            },
          },
        };
      },
      // handle the end of the iteration.
      // 1. turn the array string into an array
      // 2. assign to the working variable json path (which is also the return value)
      (workingJsonPath) => {
        return {
          startState: "format",
          states: {
            format: ASLGraph.assignJsonPathOrIntrinsic(
              ASLGraph.intrinsicStringToJson(
                ASLGraph.intrinsicFormat(
                  "{}]",
                  ASLGraph.jsonPath(workingJsonPath, "arrStr")
                )
              ),
              workingJsonPath,
              "result",
              "set"
            ),
            // filterResult = filterResult.result
            set: {
              Type: "Pass",
              // the original array is initialized with a leading null to simplify the adding of new values to the array string "[null"+",{new item}"+"]"
              InputPath: `${workingJsonPath}.result[1:]`,
              ResultPath: workingJsonPath,
              Next: ASLGraph.DeferNext,
            },
          },
        };
      }
    );
  }

  private includesToASLGraph(
    expr: CallExpr & {
      expr: PropAccessExpr;
    }
  ) {
    const [valueArg, startIndex] = expr.args;

    if (!valueArg) {
      throw new SynthError(
        ErrorCodes.Invalid_Input,
        "Expected includes() searchElement argument to exist."
      );
    }

    return this.evalContext(
      expr,
      ({
        evalExprToJsonPath,
        evalExprToJsonPathOrLiteral,
        addState,
        normalizeOutputToJsonPath,
      }) => {
        // if there is a start index, compute the sub-array first
        const subArray = startIndex
          ? this.subArray(startIndex.expr, expr.expr.expr, startIndex.expr)
          : // otherwise, evaluate the array to a jsonPath
            evalExprToJsonPath(expr.expr.expr);
        const subArrayOutput = ASLGraph.isOutputStateOrSubState(subArray)
          ? subArray.output
          : subArray;
        // if there are states required to generate the sub-array, add them.
        if (ASLGraph.isStateOrSubState(subArray)) {
          addState(subArray);
        }

        // if the sub array is still a literal, turn into a jsonPath.
        const normSubArrayOut = normalizeOutputToJsonPath(subArrayOutput);

        // evaluate the search value.
        const valueOutput = evalExprToJsonPathOrLiteral(valueArg?.expr);
        const normValueOutput =
          ASLGraph.isLiteralObject(valueOutput) ||
          ASLGraph.isLiteralArray(valueOutput)
            ? normalizeOutputToJsonPath(valueOutput)
            : valueOutput;

        return this.assignJsonPathOrIntrinsic(
          ASLGraph.intrinsicArrayContains(normSubArrayOut, normValueOutput)
        );
      }
    );
  }

  /**
   * Provides a method to sub-array given any combination of reference or literal.
   * Step functions/ASL does not allow sub-arraying with dynamic keys, but allows
   * Static slices (jsonPath) and
   */
  private subArray(
    node: FunctionlessNode,
    array: Expr,
    start?: Expr,
    end?: Expr
  ):
    | (ASLGraph.OutputSubState & { output: ASLGraph.JsonPath })
    | ASLGraph.LiteralValue
    | ASLGraph.JsonPath {
    return this.evalContext(
      node,
      ({ evalExprToJsonPathOrLiteral, normalizeOutputToJsonPath }) => {
        const arrayOut = evalExprToJsonPathOrLiteral(array);
        const startOutTemp = start
          ? evalExprToJsonPathOrLiteral(start, true)
          : undefined;
        const startOut =
          !startOutTemp || ASLGraph.isLiteralUndefined(startOutTemp)
            ? undefined
            : startOutTemp;
        const endOutTemp = end
          ? evalExprToJsonPathOrLiteral(end, true)
          : undefined;
        const endOut =
          !endOutTemp || ASLGraph.isLiteralUndefined(endOutTemp)
            ? undefined
            : endOutTemp;

        if (
          ASLGraph.isLiteralValue(arrayOut) &&
          !ASLGraph.isLiteralArray(arrayOut)
        ) {
          throw new SynthError(
            ErrorCodes.Invalid_Input,
            "Expected subArray array to be an array literal or a reference"
          );
        } else if (
          startOut &&
          ASLGraph.isLiteralValue(startOut) &&
          !ASLGraph.isLiteralNumber(startOut)
        ) {
          throw new SynthError(
            ErrorCodes.Invalid_Input,
            "Expected subArray start to be an number or a reference"
          );
        } else if (
          endOut &&
          ASLGraph.isLiteralValue(endOut) &&
          !ASLGraph.isLiteralNumber(endOut)
        ) {
          throw new SynthError(
            ErrorCodes.Invalid_Input,
            "Expected subArray end to be an number or a reference"
          );
        }

        // the unlikely case all of them are literals (most arrays will be jsonPaths because of States.Array)
        if (
          (!startOut || ASLGraph.isLiteralValue(startOut)) &&
          (!endOut || ASLGraph.isLiteralValue(endOut))
        ) {
          if (ASLGraph.isLiteralArray(arrayOut)) {
            return {
              value: arrayOut.value.slice(startOut?.value, endOut?.value),
              containsJsonPath: false,
            };
          } else {
            return {
              jsonPath:
                startOut && endOut
                  ? `${arrayOut.jsonPath}[${startOut.value}:${endOut.value}]`
                  : startOut
                  ? `${arrayOut.jsonPath}[${startOut.value}:]`
                  : endOut
                  ? `${arrayOut.jsonPath}[:${endOut.value}]`
                  : arrayOut.jsonPath,
            };
          }
        }

        /**
         * Now we need the array to be a runtime reference, normalize it.
         */
        const normArrayOut = normalizeOutputToJsonPath(arrayOut);

        const workingSpace = this.newHeapVariable();
        return {
          startState: "init",
          states: {
            init: {
              Type: "Pass",
              Parameters: {
                // ArrayRange is inclusive, need to subtract one from end
                "indices.$": ASLGraph.renderIntrinsicFunction(
                  ASLGraph.intrinsicArrayRange(
                    startOut ?? 0,
                    ASLGraph.intrinsicMathAdd(
                      endOut ?? ASLGraph.intrinsicArrayLength(normArrayOut),
                      -1
                    ),
                    1
                  )
                ),
                str: "[null",
              },
              ResultPath: workingSpace,
              Next: "checkRange",
            },
            checkRange: {
              Type: "Choice",
              Choices: [
                {
                  // any indices left?
                  ...ASL.isPresent(`${workingSpace}.indices[0]`),
                  Next: "assignAndTail",
                },
              ],
              Default: "final",
            },
            assignAndTail: {
              Type: "Pass",
              Parameters: {
                // tail
                "indices.$": `${workingSpace}.indices[1:]`,
                // append
                "str.$": ASLGraph.renderIntrinsicFunction(
                  ASLGraph.intrinsicFormat(
                    "{},{}",
                    ASLGraph.jsonPath(workingSpace, "str"),
                    ASLGraph.intrinsicJsonToString(
                      ASLGraph.intrinsicArrayGetItem(
                        normArrayOut,
                        ASLGraph.jsonPath(workingSpace, "indices[0]")
                      )
                    )
                  )
                ),
              },
              ResultPath: workingSpace,
              Next: "checkRange",
            },
            final: ASLGraph.assignJsonPathOrIntrinsic(
              ASLGraph.intrinsicStringToJson(
                ASLGraph.intrinsicFormat(
                  "{}]",
                  ASLGraph.jsonPath(workingSpace, "str")
                )
              ),
              workingSpace,
              "arr"
            ),
          },
          output: ASLGraph.jsonPath(workingSpace, "arr[1:]"),
        };
      }
    );
  }

  private mapToStateOutput(
    expr: CallExpr & {
      expr: PropAccessExpr;
    }
  ) {
    const callbackfn = expr.args[0]?.expr;
    if (!isFunctionLike(callbackfn)) {
      throw new SynthError(
        ErrorCodes.Invalid_Input,
        `the 'callback' argument of map must be a function or arrow expression, found: ${callbackfn?.kindName}`
      );
    }

    return this.evalExprToJsonPath(expr.expr.expr, (listOutput) => {
      // we assume that an array literal or a call would return a variable.
      if (
        ASLGraph.isLiteralValue(listOutput) &&
        !Array.isArray(listOutput.value)
      ) {
        throw new SynthError(
          ErrorCodes.Unexpected_Error,
          "Expected input to map to be a variable reference or array"
        );
      }

      return this.iterateArrayMethod(
        callbackfn,
        listOutput.jsonPath,
        true,
        {
          arrStr: "[null",
        },
        ({
          tailJsonPath,
          tailTarget,
          iterationResult,
          workingSpaceJsonPath,
        }) => {
          return {
            Type: "Pass",
            Parameters: {
              [`${tailTarget}.$`]: `${tailJsonPath}`,
              // const arrStr = `${arrStr},${JSON.stringify(arr[0])}`;
              "arrStr.$": ASLGraph.renderIntrinsicFunction(
                ASLGraph.intrinsicFormat(
                  "{},{}",
                  ASLGraph.jsonPath(workingSpaceJsonPath, "arrStr"),
                  ASLGraph.intrinsicJsonToString(
                    ASLGraph.jsonPath(iterationResult)
                  )
                )
              ),
            },
            ResultPath: workingSpaceJsonPath,
            Next: ASLGraph.DeferNext,
          };
        },
        (workingSpaceJsonPath) => {
          return {
            startState: "format",
            states: {
              format: ASLGraph.assignJsonPathOrIntrinsic(
                ASLGraph.intrinsicStringToJson(
                  ASLGraph.intrinsicFormat(
                    "{}]",
                    ASLGraph.jsonPath(workingSpaceJsonPath, "arrStr")
                  )
                ),
                workingSpaceJsonPath,
                "result",
                "set"
              ),
              // filterResult = filterResult.result
              set: {
                Type: "Pass",
                // the original array is initialized with a leading null to simplify the adding of new values to the array string "[null"+",{new item}"+"]"
                InputPath: `${workingSpaceJsonPath}.result[1:]`,
                ResultPath: workingSpaceJsonPath,
                Next: ASLGraph.DeferNext,
              },
            },
          };
        }
      );
    });
  }

  private forEachToStateOutput(
    expr: CallExpr & {
      expr: PropAccessExpr;
    }
  ) {
    const callbackfn = expr.args[0]?.expr;
    if (!isFunctionLike(callbackfn)) {
      throw new SynthError(
        ErrorCodes.Invalid_Input,
        `the 'callback' argument of forEach must be a function or arrow expression, found: ${callbackfn?.kindName}`
      );
    }
    return this.evalExprToJsonPath(expr.expr.expr, (listOutput) => {
      // we assume that an array literal or a call would return a variable.
      if (
        ASLGraph.isLiteralValue(listOutput) &&
        !Array.isArray(listOutput.value)
      ) {
        throw new SynthError(
          ErrorCodes.Unexpected_Error,
          "Expected input to map to be a variable reference or array"
        );
      }

      return this.iterateArrayMethod(
        callbackfn,
        listOutput.jsonPath,
        true,
        {},
        undefined,
        (workingSpaceJsonPath) => ({
          Type: "Pass",
          Result: this.context.null,
          ResultPath: workingSpaceJsonPath,
          Next: ASLGraph.DeferNext,
        })
      );
    });
  }

  /**
   * Generic, plugable helper for array methods likes map, forEach, and filter.
   *
   * Expects a function in the form arr.(item, index, array) => {};
   *
   * `workingSpace` - a state location used by the array method machine. We'll write over this location with the result after.
   *
   * 1. init - initializes a working copy of the array, used to tail the array in the `workingSpace` (workingSpace.arr)
   *    1. [optional] - user provided parameter values to initialize the `workingSpace`
   * 2. check - check if the tailed array (`workingSpace.arr`) has more items.
   *    1. If yes, go to next, else go to `end` state.
   * 3. assignParameters - setup the current item, index, and array parameters, including handling any binding. Only if the parameter is defined by the program.
   * 4. body - execute the body of the function, with any return values going to the `iterationResultJsonPath`
   * 5. handle result - optional - optionally handle the result and customize the tail operation. Often the tail and handle logic can be joined together into one state.
   * 6. tail - if tail was not bypassed in the handle result step, update the `workingSpace.arr` to the tail of the array `workingSpace.arr[1:]`.
   * 7. check - return to the check state
   * 8. end - once the array is empty, execute the end state provided by the caller. Generally writing the result to the `workingSpace` location.
   */
  private iterateArrayMethod(
    func: FunctionLike,
    /**
     * The array to iterate on as a json path.
     */
    arrayJsonPath: string,
    /**
     * When true, the current array location will be re-used to store the function result.
     *
     * `workingSpace.arr[0]`
     *
     * This option saves creating a new memory location for result, but means the original item is not available during handleResult.
     *
     * The `tail` step will erase this value. `workingSpace.arr[0] = workingSpace.arr[1:]`
     */
    overwriteIterationItemResult: boolean,
    /**
     * Additional values to be initialized in the first state of the iteration.
     *
     * Note: This should not make use of json path values from the state.
     *       ResultSelector is used on the Map state which only references the result and not
     *       the greater state.
     */
    initValues: Record<string, Parameters>,
    /**
     * Generate states to handle the output of the iteration function.
     *
     * iterationFunction -> handler (?) -> tail -> check
     *
     * if {@link ASLGraph.DeferNext} is given as the NEXT the "check" step will be wired. To navigate to the default "tail" state use the given `tailStateName`.
     *
     * if undefined, the body will go directly to the `tail` step and any output of the iteration method will be lost.
     */
    handleIterationResult:
      | ((context: {
          /**
           * The location where the result of the function is stored.
           */
          iterationResult: string;
          itemJsonPath: string;
          tailStateName: string;
          tailJsonPath: string;
          /**
           * The object key to assign the tail to.
           *
           * Example
           * {
           *    Type: "Pass",
           *    Parameters: {
           *       `${tailTarget}.$`: tailJsonPath
           *    },
           *    ResultPath: ResultPath
           * }
           */
          tailTarget: string;
          /**
           * The position to update with the tailed array and any other data.
           *
           * [workingSpaceJsonPath]: {
           *    [tailTarget]: [tailJsonPath],
           *    ... anything else ...
           * }
           * =>
           * [workingSpaceJsonPath]: {
           *    arr.$: resultPath.arr[1:],
           *    ... anything else ...
           * }
           */
          workingSpaceJsonPath: string;
        }) => ASLGraph.NodeState | ASLGraph.SubState)
      | undefined,
    /**
     * A callback to return the end states(s).
     *
     * End should write over the working variable with the return value.
     *
     * return a special variable created during `init` and `handleIteration` as the method result.
     *
     * ex:
     * {
     *    Type: "Pass",
     *    InputPath: `${workingVariable}.someAccValue`,
     *    ResultPath: workingVariable
     * }
     */
    getEndState: (
      workingVariable: string
    ) => ASLGraph.NodeState | ASLGraph.SubState
  ): ASLGraph.OutputSubState {
    const workingSpaceJsonPath = this.newHeapVariable();

    const [itemParameter, indexParameter, arrayParameter] = func.parameters;

    const workingArrayName = "arr";
    const workingArray = `${workingSpaceJsonPath}.${workingArrayName}`; // { arr: [items] }
    const headJsonPath = `${workingArray}[0]`;
    const tailJsonPath = `${workingArray}[1:]`;
    // when the index parameter is given, we zip the index and item into a new array. The item will actually be at arr[pos].item.
    const itemJsonPath = indexParameter ? `${headJsonPath}.item` : headJsonPath;
    // this path is only used when the index parameter is provided.
    const indexJsonPath = `${headJsonPath}.index`;

    const functionResult = overwriteIterationItemResult
      ? headJsonPath
      : this.newHeapVariable();

    const assignParameters = ASLGraph.joinSubStates(
      func,
      itemParameter
        ? this.evalDecl(itemParameter, { jsonPath: itemJsonPath })
        : undefined,
      indexParameter
        ? this.evalDecl(indexParameter, {
            jsonPath: indexJsonPath,
          })
        : undefined,
      arrayParameter
        ? this.evalDecl(arrayParameter, {
            jsonPath: arrayJsonPath,
          })
        : undefined
    );

    /**
     * Provide a globally unique state name to return from in the iteration body.
     */
    const uniqueReturnName = this.generatedNames.generateOrGet(func);

    const functionBody = this.evalStmt(func.body, {
      End: undefined,
      ResultPath: functionResult,
      Next: uniqueReturnName,
    });

    /**
     * Get the caller provided handle state if provided.
     */
    const handleResult = handleIterationResult?.({
      iterationResult: functionResult,
      itemJsonPath,
      tailStateName: "tail",
      tailJsonPath,
      tailTarget: workingArrayName,
      workingSpaceJsonPath: workingSpaceJsonPath,
    });

    /**
     * Get the caller provided end state, if provided.
     */
    const endState = getEndState(workingSpaceJsonPath);

    return {
      startState: "init",
      states: {
        init: indexParameter
          ? {
              ...this.zipArray(arrayJsonPath),
              ResultSelector: {
                // copy array to tail it
                [`${workingArrayName}.$`]: "$",
                ...initValues,
              },
              ResultPath: workingSpaceJsonPath,
              Next: "check",
            }
          : {
              Type: "Pass",
              Parameters: {
                // copy array to tail it
                [`${workingArrayName}.$`]: arrayJsonPath,
                ...initValues,
              },
              // use the eventual result location as a temp working space
              ResultPath: workingSpaceJsonPath,
              Next: "check",
            },
        check: {
          Type: "Choice",
          Choices: [{ ...ASL.isPresent(headJsonPath), Next: "assign" }],
          Default: "end",
        },
        // unique return name used by deep returns
        [uniqueReturnName]: {
          Type: "Pass",
          Next: handleResult ? "handleResult" : "tail",
        },
        // assign the item parameter the head of the temp array
        assign: ASLGraph.updateDeferredNextStates(
          { Next: "body" },
          assignParameters ?? { Type: "Pass", Next: ASLGraph.DeferNext }
        ),
        // run the predicate function logic
        body: ASLGraph.updateDeferredNextStates(
          { Next: handleResult ? "handleResult" : "tail" },
          functionBody ?? { Type: "Pass", Next: ASLGraph.DeferNext }
        ),
        ...(handleResult
          ? {
              handleResult: ASLGraph.updateDeferredNextStates(
                { Next: "check" },
                handleResult
              ),
            }
          : {}),
        // tail
        tail: {
          Type: "Pass",
          InputPath: tailJsonPath,
          ResultPath: workingArray,
          Next: "check",
        },
        // parse the arrStr back to json and assign over the filter result value.
        end: endState,
      },
      output: { jsonPath: workingSpaceJsonPath },
    };
  }

  /**
   * We're indexing the array we're iterating over with the key. For this special case, we know that
   * the value points to `$$.Map.Item.Value`.
   *
   * In the below example:
   * 1. the value of `$$.Map.Item.Index` is stashed in `$.i` (as expected)
   * 2. the value of `$$.Map.Item.Value` is stashed in `$.0_i`. Special `0_` prefix is impossible
   *    to produce with TypeScript syntax and is therefore safe to use a prefix to store the hidden value.
   *
   * ```ts
   * for (const i in items) {
   *   const a = items[i]
   *   {
   *     Type: Pass
   *     ResultPath: $.a
   *     InputPath: "$.0_i"
   *   }
   * }
   * ```
   */
  private elementAccessExprToJsonPath(
    access: ElementAccessExpr,
    allowUndefined?: boolean
  ): ASLGraph.NodeResults {
    // special case when in a for-in loop
    if (isIdentifier(access.element)) {
      const element = access.element.lookup();
      if (
        isVariableDecl(element) &&
        access.findParent((parent): parent is ForInStmt => {
          if (isForInStmt(parent)) {
            if (isIdentifier(parent.initializer)) {
              // let i;
              // for (i in ..)
              return element === parent.initializer.lookup();
            } else if (isVariableDeclList(parent.initializer)) {
              // for (let i in ..)
              return parent.initializer.decls[0] === element;
            }
          }
          return false;
        })
      ) {
        // the array element is assigned to $.0__[name]
        return { jsonPath: `$.0__${this.getIdentifierName(access.element)}` };
      }
    }

    return this.evalContext(
      access.element,
      ({ evalExprToJsonPathOrLiteral, normalizeOutputToJsonPath }) => {
        const elementOutput = evalExprToJsonPathOrLiteral(
          access.element,
          allowUndefined && access.isOptional
        );
        const arrayOutput = evalExprToJsonPathOrLiteral(access.expr);

        if (
          ASLGraph.isLiteralString(elementOutput) &&
          elementOutput.value === "length"
        ) {
          const lengthAccess = this.accessLengthProperty(arrayOutput);
          if (lengthAccess) {
            return lengthAccess;
          }
        }

        if (ASLGraph.isLiteralValue(elementOutput)) {
          if (elementOutput.value === undefined) {
            return {
              value: undefined as any,
              containsJsonPath: false,
            };
          } else if (
            ASLGraph.isLiteralString(elementOutput) ||
            ASLGraph.isLiteralNumber(elementOutput)
          ) {
            return ASLGraph.accessConstant(arrayOutput, elementOutput, true);
          }
          throw new SynthError(
            ErrorCodes.StepFunctions_Invalid_collection_access,
            "Collection element accessor must be a constant string or number"
          );
        } else {
          // if the array is a literal (unlikely), turn it into a json path to access it.
          const normArrayOutput = normalizeOutputToJsonPath(arrayOutput);

          const accessArray = this.assignJsonPathOrIntrinsic(
            ASLGraph.intrinsicArrayGetItem(normArrayOutput, elementOutput)
          );

          const _catch = this.throw(access);

          return this.disambiguateArrayObject(
            normArrayOutput,
            accessArray,
            _catch
              ? {
                  Type: "Pass",
                  Parameters: {
                    error: "Functionless.InvalidAccess",
                    cause: "Reference element access is not valid for objects.",
                  },
                  ..._catch,
                }
              : {
                  Type: "Fail",
                  Error: "Functionless.InvalidAccess",
                  Cause: "Reference element access is not valid for objects.",
                },
            accessArray.output.jsonPath,
            true
          );
        }
      }
    );
  }

  /**
   * Attempts to access the length property on an array or a reference that maybe an array,
   * returns undefined when it cannot do so.
   */
  private accessLengthProperty(output: ASLGraph.Output) {
    if (ASLGraph.isLiteralArray(output)) {
      return { value: output.value.length, containsJsonPath: false };
    } else if (ASLGraph.isJsonPath(output)) {
      const temp = this.newHeapVariable();
      return this.disambiguateArrayObject(
        output,
        this.arrayLength(output, temp, "val"),
        this.assignValue(
          undefined,
          { jsonPath: `${output.jsonPath}.length` },
          `${temp}.val`
        ),
        `${temp}.val`,
        true,
        "length"
      );
    }
    return undefined;
  }

  private arrayLength(
    arrayJsonPath: ASLGraph.JsonPath,
    resultPath: string,
    propertyName: string
  ) {
    return ASLGraph.assignJsonPathOrIntrinsic(
      ASLGraph.intrinsicArrayLength(arrayJsonPath),
      resultPath,
      propertyName
    );
  }

  /**
   * Provides states that attempt to disambiguate an array and object at runtime.
   *
   * is array of length 1 => arr
   * has prop hint => obj
   * stringify
   *    is [] => arr
   * => obj
   *
   * @param propertyHint - a property that is expected to exist if the value is an object.
   * @param arrayOrObjectReference - a json path that may be an array or object
   * @param whenArray - the state(s) to execute when we think the value is an array
   * @param whenObject - the state(s) to execute when we think the value is an object
   * @param resultPath - the json path both `whenObject` and `whenArray` output to.
   * @param canAssignResultPath - when true, the machine may assign a temporary value to the result path
   *                              Do not set to `true` this if the result path may need to be used by the array/object states
   *                              or the result path is not assigned over later.
   */
  private disambiguateArrayObject(
    arrayOrObjectReference: ASLGraph.JsonPath,
    whenArray: ASLGraph.SubState | ASLGraph.NodeState,
    whenObject: ASLGraph.SubState | ASLGraph.NodeState,
    resultPath: string,
    canAssignResultPath: boolean,
    propertyHint?: string
  ): ASLGraph.OutputSubState {
    const strTemp = canAssignResultPath ? resultPath : this.newHeapVariable();
    return {
      startState: "check",
      states: {
        check: {
          Type: "Choice",
          Choices: [
            {
              ...ASL.and(
                // definitely an array of length at least 1
                ASL.isPresent(`${arrayOrObjectReference.jsonPath}[0]`)
              ),
              Next: "array",
            },
            ...(propertyHint
              ? [
                  {
                    ...ASL.isPresent(
                      `${arrayOrObjectReference.jsonPath}['${propertyHint}']`
                    ),
                    Next: "object",
                  },
                ]
              : []),
          ],
          Default: "stringify",
        },
        array: whenArray,
        object: whenObject,
        stringify: ASLGraph.assignJsonPathOrIntrinsic(
          ASLGraph.intrinsicJsonToString(arrayOrObjectReference),
          strTemp,
          "str",
          "checkString"
        ),
        checkString: {
          Type: "Choice",
          Choices: [
            { ...ASL.stringEquals(`${strTemp}.str`, "[]"), Next: "array" },
          ],
          Default: "object",
        },
      },
      output: {
        jsonPath: resultPath,
      },
    };
  }

  /**
   * Asserts that an {@link ASLGraph.Output} is a constant and is a number or string.
   *
   * Element access in StepFunctions must be constant because dynamic object is not supported.
   */
  private getElementAccessConstant(value: ASLGraph.Output): string | number {
    if (ASLGraph.isLiteralValue(value) && !value.containsJsonPath) {
      if (typeof value.value === "string" || typeof value.value === "number") {
        return value.value;
      }
    }

    throw new SynthError(
      ErrorCodes.StepFunctions_Invalid_collection_access,
      "Collection element accessor must be a constant string or number"
    );
  }

  /**
   * In some cases, variable can be batch declared as state parameters.
   * This method is an alternative to {@link evalDecl} which can evaluate multiple {@link ParameterDecl}s
   * with initial values into a parameter object and any state to be run after (which setup any bound variables.)
   *
   * Parameter with identifier names become State Parameter keys
   *
   * `(input) => {}`
   * ->
   * ```ts
   * {
   *    Type: "Pass", // or Task, Name, etc
   *    Parameters: {
   *       "input.$": jsonPath
   *    }
   * }
   * ```
   *
   * `({ value }) => {}`
   * ->
   * ```ts
   * {
   *    Type: "Pass",
   *    InputPath: jsonPath,
   *    ResultPath: "$.value"
   * }
   * ```
   *
   * A Parameter object will be more efficient as multiple values can be bound in a single State rather than multiple passes.
   *
   * However:
   * 1. a State Parameter object can only override the entire state, it cannot update or add a subset of all variable names.
   * 2. a State Parameter object only supports json path computation. Complex situations like invoking an {@link Integration} or
   *    default value support for binding patterns would not be supported.
   *
   * @returns a tuple of
   *          1. a {@link Parameters} object intended to be used in the Parameters or ResultSelector of a state.
   *             Contains the initialized parameter names. Could be empty.
   *          2. a state or sub-state used to generate the bound names. May be undefined.
   */
  public evalParameterDeclForStateParameter(
    node: FunctionlessNode,
    ...parameters: ASL.EvalParameterDeclEntry[]
  ): [
    Record<string, Parameters>,
    ASLGraph.NodeState | ASLGraph.SubState | undefined
  ] {
    // Parameter with identifier names become State Parameter keys
    const params = Object.fromEntries(
      parameters
        .filter(
          (parameter): parameter is ASL.EvalParameterDeclEntry<Identifier> =>
            isIdentifier(parameter.parameter?.name)
        )
        .map(
          ({ parameter, valuePath: { jsonPath } }) =>
            [`${this.getIdentifierName(parameter!.name)}.$`, jsonPath] as const
        )
    );

    // Parameters with binding names become variable assignments.
    const binds = parameters
      .filter(
        (parameter): parameter is ASL.EvalParameterDeclEntry<BindingPattern> =>
          isBindingPattern(parameter.parameter?.name)
      )
      .map(({ parameter, valuePath, reassignBoundParameters }) => {
        const variableName = reassignBoundParameters
          ? this.newHeapVariableName()
          : valuePath.jsonPath;

        return {
          // some contexts cannot use the same jsonPath in Parameter and assignments like Map states.
          // if reassignBoundParameters is true, create a new variable name and write up the references.
          reassign: reassignBoundParameters
            ? ([`${variableName}.$`, valuePath.jsonPath] as const)
            : undefined,
          states: this.evalAssignment(
            parameter!.name,
            ASLGraph.jsonPath(variableName)
          ),
        };
      });

    return [
      {
        ...params,
        // parameters generated by the binding elements
        ...Object.fromEntries(
          binds
            .filter((bind) => !!bind.reassign)
            .map(({ reassign }) => reassign!)
        ),
      },
      ASLGraph.joinSubStates(node, ...binds.map(({ states }) => states)),
    ];
  }

  public evalDecl(
    decl: VariableDecl | ParameterDecl,
    initialValue?: ASLGraph.Output
  ): ASLGraph.SubState | ASLGraph.NodeState | undefined {
    const state = (() => {
      if (initialValue) {
        return this.evalAssignment(decl.name, initialValue);
      } else if (decl.initializer === undefined) {
        return undefined;
      }

      return this.evalExprToSubState(decl.initializer, (exprOutput) => {
        return this.evalAssignment(decl.name, exprOutput);
      });
    })();
    return state ? { node: decl, ...state } : undefined;
  }

  /**
   * Generic handler for any type of assignment with either an identifier or a binding pattern (deconstruction).
   *
   * Nested BindPatterns are handled recursively.
   *
   * const x = 1;
   * =>
   * const x = 1;
   *
   * const { x } = y;
   * =>
   * const x = y.x;
   *
   * const { x } = { x: 1 };
   * =>
   * const x = 1;
   *
   * const { x = 1 } = y;
   * =>
   * const x = y.x === undefined ? 1 : y.x;
   *
   * const { x = 1 } = {};
   * =>
   * const x = 1;
   *
   * const { x: { z } } = y;
   * =>
   * const z = y.x.z;
   *
   * const { x, ...rest } = y;
   * =>
   * INVALID - rest is unsupported in objects because ASL doesn't support object manipulation (ex: delete) or field enumeration (ex: keySet).
   *
   * const [x] = arr;
   * =>
   * const x = arr[0];
   *
   * const [,x] = arr;
   * =>
   * const x = arr[1];
   *
   * const [x,...rest] = arr;
   * =>
   * const x = arr[0];
   * const rest = arr.slice(1);
   */
  private evalAssignment(
    pattern: BindingName,
    value: ASLGraph.Output
  ): ASLGraph.SubState | ASLGraph.NodeState | undefined {
    // assign an identifier the current value
    if (isIdentifier(pattern)) {
      return this.assignValue(
        pattern,
        value,
        `$.${this.getIdentifierName(pattern)}`
      );
    } else {
      const rest = pattern.bindings.find(
        (binding) => isBindingElem(binding) && binding?.rest
      ) as BindingElem | undefined;
      if (rest && isObjectBinding(pattern)) {
        // TODO: validator
        throw new SynthError(
          ErrorCodes.StepFunctions_does_not_support_destructuring_object_with_rest
        );
      }

      // run each of the assignments as a sequence of states, they should not rely on each other.
      const assignments = pattern.bindings.map((binding, i) => {
        if (isOmittedExpr(binding) || binding.rest) {
          return undefined;
        }

        const updatedValue: ASLGraph.Output = (() => {
          if (isArrayBinding(pattern)) {
            // const [a] = arr;
            if (ASLGraph.isJsonPath(value)) {
              return {
                jsonPath: `${value.jsonPath}[${i}]`,
              };
            } else {
              // const [a] = [1,2,3];
              if (
                !(ASLGraph.isLiteralValue(value) && Array.isArray(value.value))
              ) {
                throw new SynthError(
                  ErrorCodes.Invalid_Input,
                  "Expected array binding pattern to be on a reference path or array literal."
                );
              }
              return {
                value: value.value[i],
                containsJsonPath: value.containsJsonPath,
              };
            }
          } else {
            // when `name` is a bindingPattern, propertyName should always be present.
            const propertyNameExpr = binding.propertyName ?? binding.name;
            const propertyName = isComputedPropertyNameExpr(propertyNameExpr)
              ? evalToConstant(propertyNameExpr.expr)?.constant
              : isIdentifier(propertyNameExpr)
              ? propertyNameExpr.name
              : isStringLiteralExpr(propertyNameExpr)
              ? propertyNameExpr.value
              : undefined;

            if (!propertyName || typeof propertyName !== "string") {
              throw new SynthError(
                ErrorCodes.StepFunctions_property_names_must_be_constant
              );
            }

            if (ASLGraph.isJsonPath(value)) {
              return {
                jsonPath: `${value.jsonPath}['${propertyName}']`,
              };
            } else if (ASLGraph.isLiteralObject(value)) {
              return {
                value: value.value[propertyName as keyof typeof value.value],
                containsJsonPath: value.containsJsonPath,
              };
            } else {
              throw new SynthError(
                ErrorCodes.Invalid_Input,
                "Expected object binding pattern to be on a reference path or object literal"
              );
            }
          }
        })();

        // when there is a default value
        if (binding.initializer) {
          // if there is a default value, update the output to reflect it
          const valueStatesWithDefault = this.applyDefaultValue(
            updatedValue,
            binding.initializer
          );

          // recursively assign, with the new value (original value or default value)
          const assignStates = this.evalAssignment(
            binding.name,
            ASLGraph.getAslStateOutput(valueStatesWithDefault)
          );

          // run the value states first and then the assignment which uses it
          return ASLGraph.joinSubStates(
            binding,
            valueStatesWithDefault,
            assignStates
          )!;
        }
        // if there is no default value, just continue finding assignments with the updated value.
        return this.evalAssignment(binding.name, updatedValue);
      });

      // rest is only value for arrays
      const restState = rest
        ? this.evalAssignment(
            rest.name,
            (() => {
              if (ASLGraph.isJsonPath(value)) {
                return {
                  jsonPath: `${value.jsonPath}[${
                    pattern.bindings.length - 1
                  }:]`,
                };
              } else if (
                ASLGraph.isLiteralValue(value) &&
                Array.isArray(value.value)
              ) {
                return {
                  ...value,
                  value: value.value.slice(pattern.bindings.length - 1),
                };
              } else {
                throw new SynthError(
                  ErrorCodes.Invalid_Input,
                  "Expected array binding pattern to be on a reference path or array literal."
                );
              }
            })()
          )
        : undefined;

      return ASLGraph.joinSubStates(pattern, ...assignments, restState);
    }
  }

  /**
   * Assigns an {@link ASLGraph.Output} to a jsonPath variable.
   *
   * If the {@link value} is a {@link ASLGraph.ConditionOutput}, states are added to turn
   * the condition into a boolean value.
   */
  private assignValue(
    node: FunctionlessNode | undefined,
    value: ASLGraph.Output,
    targetJsonPath?: string
  ): (ASLGraph.OutputState | ASLGraph.OutputSubState) & {
    output: ASLGraph.JsonPath;
  } {
    if (ASLGraph.isConditionOutput(value)) {
      return this.conditionState(
        node,
        value.condition,
        undefined,
        undefined,
        targetJsonPath
      );
    }
    const target = targetJsonPath ?? this.newHeapVariable();

    return {
      ...ASLGraph.passWithInput(
        {
          Type: "Pass",
          node,
          Next: ASLGraph.DeferNext,
          ResultPath: target,
        },
        value
      ),
      output: { jsonPath: target },
    };
  }

  /**
   * Given an output value (json path, literal, or condition) and an expression to compute a default value,
   * return a possibly updated output value which will contain the default value if the initial value is undefined.
   *
   * `return value === undefined ? defaultValue : value;`
   */
  private applyDefaultValue(
    value: ASLGraph.Output,
    defaultValueExpression: Expr
  ): ASLGraph.NodeResults {
    // the states to execute to compute the default value, if needed.
    const defaultValueState = this.eval(defaultValueExpression);
    const defaultValue = ASLGraph.getAslStateOutput(defaultValueState);

    // attempt to optimize the assignment of the default value.
    // if the original value is known to be undefined at runtime, we can directly return the default value
    // or fail if both will be undefined
    const updatedValue =
      ASLGraph.isLiteralValue(value) && value.value === undefined
        ? defaultValueState
        : value;
    // if the value was undefined and there is no default or the default value was also undefined, fail
    if (
      !updatedValue ||
      (ASLGraph.isLiteralValue(updatedValue) && updatedValue === undefined)
    ) {
      throw new SynthError(
        ErrorCodes.Step_Functions_does_not_support_undefined,
        "Undefined literal is not supported"
      );
    }

    if (
      // if the updated value is the default value, there is no default, or the value is a constant (and defined)
      // then just output a simple assignment
      updatedValue === defaultValueState ||
      ASLGraph.isLiteralValue(value)
    ) {
      return updatedValue;
    } else if (ASLGraph.isConditionOutput(value)) {
      // a boolean cannot be undefined.
      return this.normalizeOutputToJsonPathOrLiteralValue(value);
    } else {
      const temp = this.newHeapVariable();
      // runtime determination of default values
      return {
        startState: "check",
        states: {
          check: {
            Type: "Choice",
            // in javascript, the default value is applied only for `undefined` or missing values.
            // in ASL that is the same as NOT(ISPRESENT(jsonPath))
            Choices: [{ ...ASL.isPresent(value.jsonPath), Next: "value" }],
            Default: "default",
          },
          value: this.assignValue(undefined, value, temp),
          // default will first execute any states to compute the default value and then assign the output to the temp variable.
          default: ASLGraph.joinSubStates(
            defaultValueExpression,
            defaultValueState,
            this.assignValue(undefined, defaultValue, temp)
          )!,
        },
        output: {
          jsonPath: temp,
        },
      };
    }
  }

  /**
   * Zip an array with it's index.
   *
   * In ASL, it is not possible to do arithmetic or get the length of an array, but
   * the map state does give us the index.
   *
   * @param formatIndex allows the optional formatting of the index number, for example, turning it into a string.
   * @returns a partial map state that results in an array of { index: number, item: arrayElement[index] }.
   */
  private zipArray(
    arrayJsonPath: string,
    formatIndex: (indexJsonPath: string) => string = (index) => index
  ): Pick<MapTask, "Type" | "ItemsPath" | "Parameters" | "Iterator"> {
    return {
      Type: "Map" as const,
      ItemsPath: arrayJsonPath,
      Parameters: {
        "index.$": formatIndex("$$.Map.Item.Index"),
        "item.$": "$$.Map.Item.Value",
      },
      Iterator: this.aslGraphToStates({
        Type: "Pass",
        ResultPath: "$",
        Next: ASLGraph.DeferNext,
      }),
    };
  }
}

export namespace ASL {
  export interface EvalParameterDeclEntry<
    Name extends BindingName = BindingName
  > {
    parameter: (ParameterDecl & { name: Name }) | undefined;
    valuePath: ASLGraph.JsonPath;
    /**
     * When true and the parameter requires states outside of the Parameter object,
     * a new name will created in the Parameter object and assigned the valuePath.
     *
     * This is useful for Map states where the $$.Map.Item.* values
     * are not present inside of the map states.
     */
    reassignBoundParameters?: boolean;
  }

  export function isTruthy(v: string): Condition {
    return and(
      isPresentAndNotNull(v),
      or(
        and(isString(v), not(stringEquals(v, ""))),
        and(isNumeric(v), not(numericEquals(v, 0))),
        and(isBoolean(v), booleanEquals(v, true)),
        // is object or array: is present, not null, and not a primitive
        not(or(isBoolean(v), isNumeric(v), isString(v)))
      )
    );
  }

  export function and(...cond: (Condition | undefined)[]): Condition {
    const conds = cond.filter((c): c is Condition => !!c);
    return conds.length > 1
      ? {
          And: conds,
        }
      : conds.length === 0
      ? ASL.trueCondition()
      : conds[0]!;
  }

  export function or(...cond: (Condition | undefined)[]): Condition {
    const conds = cond.filter((c): c is Condition => !!c);
    return conds.length > 1
      ? {
          Or: conds,
        }
      : conds.length === 0
      ? ASL.falseCondition()
      : conds[0]!;
  }

  export function not(cond: Condition): Condition {
    return {
      Not: cond,
    };
  }

  export function isPresent(Variable: string): Condition {
    return {
      IsPresent: true,
      Variable,
    };
  }

  export function isNotPresent(Variable: string): Condition {
    return {
      IsPresent: false,
      Variable,
    };
  }

  export function isNull(Variable: string): Condition {
    return {
      IsNull: true,
      Variable,
    };
  }

  export function isNotNull(Variable: string): Condition {
    return {
      IsNull: false,
      Variable,
    };
  }

  export function isBoolean(Variable: string): Condition {
    return {
      IsBoolean: true,
      Variable,
    };
  }

  export function isString(Variable: string): Condition {
    return {
      IsString: true,
      Variable,
    };
  }

  export function isNumeric(Variable: string): Condition {
    return {
      IsNumeric: true,
      Variable,
    };
  }

  export function isPresentAndNotNull(Variable: string): Condition {
    return ASL.and(ASL.isPresent(Variable), ASL.isNotNull(Variable));
  }

  export function stringEqualsPath(Variable: string, path: string): Condition {
    return {
      And: [
        isString(Variable),
        {
          StringEqualsPath: path,
          Variable,
        },
      ],
    };
  }

  export function stringEquals(Variable: string, string: string): Condition {
    return {
      And: [
        isString(Variable),
        {
          StringEquals: string,
          Variable,
        },
      ],
    };
  }

  export function numericEqualsPath(Variable: string, path: string): Condition {
    return {
      And: [
        isNumeric(Variable),
        {
          NumericEqualsPath: path,
          Variable,
        },
      ],
    };
  }

  export function numericEquals(Variable: string, number: number): Condition {
    return {
      And: [
        isNumeric(Variable),
        {
          NumericEquals: number,
          Variable,
        },
      ],
    };
  }

  export function numericLessThan(Variable: string, number: number): Condition {
    return {
      NumericLessThan: number,
      Variable,
    };
  }

  export function numericLessThanPath(
    Variable: string,
    path: string
  ): Condition {
    return {
      NumericLessThanPath: path,
      Variable,
    };
  }

  export function numericGreaterThanEquals(
    Variable: string,
    number: number
  ): Condition {
    return {
      NumericGreaterThanEquals: number,
      Variable,
    };
  }

  export function booleanEqualsPath(Variable: string, path: string): Condition {
    return {
      BooleanEqualsPath: path,
      Variable,
    };
  }

  export function booleanEquals(Variable: string, value: boolean): Condition {
    return {
      BooleanEquals: value,
      Variable,
    };
  }

  /**
   * Supported comparison operators.
   *
   * Note: !== and != can be achieved by using {@link ASL.not}.
   */
  export type ValueComparisonOperators =
    | "==="
    | "=="
    | ">"
    | ">="
    | "<="
    | "<"
    | "!="
    | "!==";

  // for != use not(equals())
  export const VALUE_COMPARISONS: Record<
    ValueComparisonOperators,
    Record<"string" | "boolean" | "number", keyof Condition | undefined>
  > = {
    "==": {
      string: "StringEquals",
      boolean: "BooleanEquals",
      number: "NumericEquals",
    },
    "===": {
      string: "StringEquals",
      boolean: "BooleanEquals",
      number: "NumericEquals",
    },
    "<": {
      string: "StringLessThan",
      boolean: undefined,
      number: "NumericLessThan",
    },
    "<=": {
      string: "StringLessThanEquals",
      boolean: undefined,
      number: "NumericLessThanEquals",
    },
    ">": {
      string: "StringGreaterThan",
      boolean: undefined,
      number: "NumericGreaterThan",
    },
    ">=": {
      string: "StringGreaterThanEquals",
      boolean: undefined,
      number: "NumericGreaterThanEquals",
    },
    "!=": { string: undefined, boolean: undefined, number: undefined },
    "!==": { string: undefined, boolean: undefined, number: undefined },
  };

  export function compareValueOfType(
    Variable: string,
    operation: keyof typeof VALUE_COMPARISONS,
    value: string | number | boolean
  ): Condition {
    const comparison =
      VALUE_COMPARISONS[operation][
        typeof value as "string" | "number" | "boolean"
      ];

    if (!comparison) {
      return ASL.falseCondition();
    }

    return {
      Variable,
      [comparison]: value,
    };
  }

  export function comparePathOfType(
    Variable: string,
    operation: keyof typeof VALUE_COMPARISONS,
    path: string,
    type: "string" | "number" | "boolean"
  ): Condition {
    const comparison = VALUE_COMPARISONS[operation][type];

    if (!comparison) {
      return ASL.falseCondition();
    }

    return {
      Variable,
      [`${comparison}Path`]: path,
    };
  }

  export function falseCondition() {
    return ASL.isNull("$$.Execution.Id");
  }
  export function trueCondition() {
    return ASL.isNotNull("$$.Execution.Id");
  }
}

// to prevent the closure serializer from trying to import all of functionless.
export const deploymentOnlyModule = true;
