import "jest";
import {
  ArithmeticOp,
  BinaryLogicalOp,
  EqualityOp,
  RelationalOp,
} from "@functionless/ast";
import { $util, AppsyncContext } from "@functionless/aws-appsync-constructs";
import { appsyncTestCase, testAppsyncVelocity } from "@functionless/test";

test("empty function returning an argument", () => {
  appsyncTestCase((context: AppsyncContext<{ a: string }>) => {
    return context.arguments.a;
  });
});

test("return literal object with values", () => {
  appsyncTestCase(
    (context: AppsyncContext<{ arg: string; obj: Record<string, any> }>) => {
      const arg = context.arguments.arg;
      const obj = context.arguments.obj;
      return {
        null: null,
        undefined: undefined,
        string: "hello",
        number: 1,
        ["list"]: ["hello"],
        obj: {
          key: "value",
        },
        arg,
        ...obj,
      };
    }
  );
});

test("computed property names", () => {
  appsyncTestCase(
    (context: AppsyncContext<{ arg: string; obj: Record<string, any> }>) => {
      const name = context.arguments.arg;
      const value = name + "_test";
      return {
        [name]: context.arguments.arg,
        [value]: context.arguments.arg,
      };
    }
  );
});

test("null and undefined", () => {
  appsyncTestCase(
    (_context: AppsyncContext<{ arg: string; obj: Record<string, any> }>) => {
      return {
        name: null,
        value: undefined,
      };
    }
  );
});

test("call function and return its value", () => {
  appsyncTestCase(() => {
    return $util.autoId();
  });
});

test("call function, assign to variable and return variable reference", () => {
  appsyncTestCase(() => {
    const id = $util.autoId();
    return id;
  });
});

test("return in-line spread object", () => {
  appsyncTestCase((context: AppsyncContext<{ obj: { key: string } }>) => {
    return {
      id: $util.autoId(),
      ...context.arguments.obj,
    };
  });
});

test("return in-line list literal", () => {
  appsyncTestCase((context: AppsyncContext<{ a: string; b: string }>) => {
    return [context.arguments.a, context.arguments.b];
  });
});

test("return list literal variable", () => {
  appsyncTestCase((context: AppsyncContext<{ a: string; b: string }>) => {
    const list = [context.arguments.a, context.arguments.b];
    return list;
  });
});

test("return list element", () => {
  appsyncTestCase((context: AppsyncContext<{ a: string; b: string }>) => {
    const list = [context.arguments.a, context.arguments.b];
    return list[0];
  });
});

test("push element to array is renamed to add", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    context.arguments.list.push("hello");
    return context.arguments.list;
  });
});

// TODO https://github.com/functionless/functionless/issues/8
// test("push multiple args is expanded to multiple add calls", () => {
//   const template = (context: AppsyncContext<{ list: string[] }>) => {
//     list.push("hello", "world");
//     return list;
//   });

//   const vtl = new VTL();
//   vtl.eval(template.body);
//   const actual = vtl.toVTL();
//   const expected = `$util.qr($context.arguments.list.addAll(['hello']))
//   $util.qr($context.arguments.list.addAll(['world']))
// ${returnExpr("$context.arguments.list")}`;
//   expect(actual).toEqual(expected);
// });

test("if statement", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    if (context.arguments.list.length > 0) {
      return true;
    } else {
      return false;
    }
  });
});

test("blockless if", () => {
  appsyncTestCase<{ num: number }, void>(async ($context) => {
    if (1 === $context.arguments.num) return;
    if (1 === $context.arguments.num) {
    } else return;
  });

  // https://github.com/aws-amplify/amplify-category-api/issues/592
  // testAppsyncVelocity(templates[1]!);
});

test("return conditional expression", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list.length > 0 ? true : false;
  });
});

test("property assignment of conditional expression", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return {
      prop: context.arguments.list.length > 0 ? true : false,
    };
  });
});

test("for-of loop", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    const newList: string[] = [];
    for (const item of context.arguments.list) {
      newList.push(item);
    }
    return newList;
  });
});

test("break from for-loop", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    const newList: string[] = [];
    for (const item of context.arguments.list) {
      if (item === "hello") {
        break;
      }
      newList.push(item);
    }
    return newList;
  });
});

test("local variable inside for-of loop is declared as a local variable", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    const newList: string[] = [];
    for (const item of context.arguments.list) {
      const i = item;
      newList.push(i);
    }
    return newList;
  });
});

test("for-in loop and element access", () => {
  appsyncTestCase(
    (context: AppsyncContext<{ record: Record<string, any> }>) => {
      const newList: string[] = [];
      for (const key in context.arguments.record) {
        newList.push(context.arguments.record[key]);
      }
      return newList;
    }
  );
});

test("template expression", () => {
  appsyncTestCase((context: AppsyncContext<{ a: string }>) => {
    const local = context.arguments.a;
    return `head ${context.arguments.a} ${local}${context.arguments.a}`;
  });
});

test("conditional expression in template expression", () => {
  appsyncTestCase((context: AppsyncContext<{ a: string }>) => {
    return `head ${
      context.arguments.a === "hello" ? "world" : context.arguments.a
    }`;
  });
});

test("map over list", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list.map((item) => {
      return `hello ${item}`;
    });
  });
});

test("map over list without parameter", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list.map(() => {
      return `hello`;
    });
  });
});

test("map over list with in-line return", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list.map((item) => `hello ${item}`);
  });
});

test("chain map over list", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list
      .map((item) => `hello ${item}`)
      .map((item) => `hello ${item}`);
  });
});

test("chain map over list multiple array", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list
      .map((item, _i, _arr) => `hello ${item}`)
      .map((item, _i, _arr) => `hello ${item}`);
  });
});

test("chain map over list complex", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list
      .map((item, i, arr) => {
        const x = i + 1;
        return `hello ${item} ${x} ${arr.length}`;
      })
      .map((item2, ii) => `hello ${item2} ${ii}`);
  });
});

test("forEach over list", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list.forEach((item) => {
      $util.error(item);
    });
  });
});

test("reduce over list with initial value", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list.reduce((newList: string[], item) => {
      return [...newList, item];
    }, []);
  });
});

test("reduce over list without initial value", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list.reduce((str: string, item) => {
      return `${str}${item}`;
    });
  });
});

test("map and reduce over list with initial value", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list
      .map((item) => `hello ${item}`)
      .reduce((newList: string[], item) => {
        return [...newList, item];
      }, []);
  });
});

test("map and reduce with array over list with initial value", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list
      .map((item) => `hello ${item}`)
      .reduce((newList: string[], item, _i, _arr) => {
        return [...newList, item];
      }, []);
  });
});

test("map and reduce and map and reduce over list with initial value", () => {
  appsyncTestCase((context: AppsyncContext<{ list: string[] }>) => {
    return context.arguments.list
      .map((item) => `hello ${item}`)
      .reduce((newList: string[], item) => {
        return [...newList, item];
      }, [])
      .map((item) => `hello ${item}`)
      .reduce((newList: string[], item) => {
        return [...newList, item];
      }, []);
  });
});

test("$util.time.nowISO8601", () => {
  appsyncTestCase(() => {
    return $util.time.nowISO8601();
  });
});

test("$util.log.info(message)", () => {
  appsyncTestCase(() => {
    return $util.log.info("hello world");
  });
});

test("$util.log.info(message, ...Object)", () => {
  appsyncTestCase(() => {
    return $util.log.info("hello world", { a: 1 }, { b: 2 });
  });
});

test("$util.log.error(message)", () => {
  appsyncTestCase(() => {
    return $util.log.error("hello world");
  });
});

test("$util.log.error(message, ...Object)", () => {
  appsyncTestCase(() => {
    return $util.log.error("hello world", { a: 1 }, { b: 2 });
  });
});

test("BinaryExpr and UnaryExpr are evaluated to temporary variables", () => {
  appsyncTestCase(() => {
    return {
      x: -1,
      y: -(1 + 1),
      z: !(true && false),
    };
  });
});

test("binary expr in", () => {
  const templates = appsyncTestCase(($context) => {
    if ("key" in $context.arguments) {
      return { out: $context.arguments.key };
    }
    return { out: $context.arguments.key2 };
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { key: "hi" },
    resultMatch: { out: "hi" },
  });

  // falsey value
  testAppsyncVelocity(templates[1]!, {
    arguments: { key: "" },
    resultMatch: { out: "" },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { key2: "hello" },
    resultMatch: { out: "hello" },
  });
});

test("binary expr ==", () => {
  const templates = appsyncTestCase<{ key: string }, { out: boolean[] }, any>(
    ($context) => {
      return {
        out: [
          $context.arguments.key == "key",
          "key" == $context.arguments.key,
          $context.arguments.key === "key",
          "key" === $context.arguments.key,
        ],
      };
    }
  );

  testAppsyncVelocity(templates[1]!, {
    arguments: { key: "key" },
    resultMatch: { out: [true, true, true, true] },
  });
});

test("binary expr in map", () => {
  const templates = appsyncTestCase(() => {
    const obj = {
      key: "value",
      // $null does not appear to work in amplify simulator
      // keyNull: null,
      keyEmpty: "",
    };
    return {
      in: "key" in obj,
      notIn: "otherKey" in obj,
      // inNull: "keyNull" in obj,
      inEmpty: "keyEmpty" in obj,
    };
  });

  testAppsyncVelocity(templates[1]!, {
    resultMatch: {
      in: true,
      notIn: false,
      // inNull: true,
      inEmpty: true,
    },
  });
});

// amplify simulator does not support .class
// https://github.com/aws-amplify/amplify-cli/issues/10575
test.skip("binary expr in array", () => {
  const templates = appsyncTestCase<
    { arr: string[] },
    { out: string | undefined },
    any
  >(($context) => {
    if (1 in $context.arguments.arr) {
      return { out: $context.arguments.arr[1] };
    }
    return { out: $context.arguments.arr[0] };
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { arr: ["1", "2"] },
    resultMatch: { out: "2" },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { arr: ["1", ""] },
    resultMatch: { out: "" },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { arr: ["1"] },
    resultMatch: { out: "1" },
  });
});

test("binary exprs value comparison", () => {
  const templates = appsyncTestCase<
    { a: number; b: number },
    Record<
      | EqualityOp
      | Exclude<RelationalOp, "in" | "instanceof">
      | Exclude<BinaryLogicalOp, "??">,
      boolean | number
    >,
    any
  >(($context) => {
    const a = $context.arguments.a;
    const b = $context.arguments.b;
    return {
      "!==": a != b,
      "!=": a != b,
      "&&": a && b,
      "||": a || b,
      "<": a < b,
      "<=": a <= b,
      "===": a == b,
      "==": a == b,
      ">": a > b,
      ">=": a >= b,
    };
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { a: 1, b: 2 },
    resultMatch: {
      "!==": true,
      "!=": true,
      "<": true,
      "<=": true,
      "===": false,
      "==": false,
      ">": false,
      ">=": false,
    },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { a: 2, b: 1 },
    resultMatch: {
      "!==": true,
      "!=": true,
      "<": false,
      "<=": false,
      "===": false,
      "==": false,
      ">": true,
      ">=": true,
    },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { a: 1, b: 1 },
    resultMatch: {
      "!==": false,
      "!=": false,
      "<": false,
      "<=": true,
      "===": true,
      "==": true,
      ">": false,
      ">=": true,
    },
  });
});

test("null coalescing", () => {
  const templates = appsyncTestCase(() => {
    return {
      "??": null ?? "a",
      "not ??": "a" ?? "b",
      neither: null ?? null,
      undefined: undefined ?? "a",
    };
  });

  testAppsyncVelocity(templates[1]!, {
    resultMatch: {
      "??": null ?? "a",
      "not ??": "a" ?? "b",
      // nulls keys are not added to maps
      // neither: null ?? null,
      undefined: undefined ?? "a",
    },
  });
});

test("binary exprs logical", () => {
  const templates = appsyncTestCase<
    { a: boolean; b: boolean },
    Record<BinaryLogicalOp, boolean>,
    any
  >(($context) => {
    const a = $context.arguments.a;
    const b = $context.arguments.b;
    return {
      "&&": a && b,
      "||": a || b,
      "??": a ?? b,
    };
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { a: true, b: true },
    resultMatch: {
      "&&": true,
      "||": true,
      "??": true,
    },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { a: true, b: false },
    resultMatch: {
      "&&": false,
      "||": true,
      "??": true,
    },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { a: false, b: false },
    resultMatch: {
      "&&": false,
      "||": false,
      "??": false,
    },
  });
});

test("binary exprs math", () => {
  const templates = appsyncTestCase<
    { a: number; b: number },
    Record<Exclude<ArithmeticOp, "**">, number>,
    any
  >(($context) => {
    const a = $context.arguments.a;
    const b = $context.arguments.b;
    return {
      "+": a + b,
      "-": a - b,
      "*": a * b,
      "/": a / b,
      "%": a % b,
    };
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { a: 6, b: 2 },
    resultMatch: {
      "+": 8,
      "-": 4,
      "*": 12,
      "/": 3,
      "%": 0,
    },
  });
});

test("binary expr =", () => {
  const templates = appsyncTestCase<{ key: string }, { out: string }, any>(
    ($context) => {
      if ($context.arguments.key == "help me") {
        $context.arguments.key = "hello";
      }
      if ($context.arguments.key == "hello") {
        return { out: "ohh hi" };
      }
      return { out: "wot" };
    }
  );

  testAppsyncVelocity(templates[1]!, {
    arguments: { key: "hello" },
    resultMatch: { out: "ohh hi" },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { key: "giddyup" },
    resultMatch: { out: "wot" },
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: { key: "help me" },
    resultMatch: { out: "ohh hi" },
  });
});

// https://github.com/functionless/functionless/issues/232
test("binary mutation", () => {
  const templates = appsyncTestCase(() => {
    var n = 9;
    const plus_n = (n += 1);
    const minus_n = (n -= 1);
    const multi_n = (n *= 2);
    const div_n = (n /= 3);
    const mod_n = (n %= 2);
    return {
      "+=": plus_n,
      "-=": minus_n,
      "*=": multi_n,
      "/=": div_n,
      "%=": mod_n,
      n,
    };
  });

  testAppsyncVelocity(templates[1]!, {
    resultMatch: {
      "+=": 10,
      "-=": 9,
      "*=": 18,
      "/=": 6,
      "%=": 0,
      n: 0,
    },
  });
});

// https://github.com/functionless/functionless/issues/232
test("unary mutation", () => {
  const templates = appsyncTestCase(() => {
    var n = 9;
    return {
      "post--": n--,
      "--pre": --n,
      "post++": n++,
      "++pre": ++n,
    };
  });

  testAppsyncVelocity(templates[1]!, {
    resultMatch: {
      "post--": 9, // 8
      "--pre": 7, // 7
      "post++": 7, // 8
      "++pre": 9, //9
    },
  });
});

// https://github.com/functionless/functionless/issues/232
test("unary", () => {
  const templates = appsyncTestCase(() => {
    return {
      "!": !false,
      "-": -10,
      "-(-)": -(-10),
    };
  });

  testAppsyncVelocity(templates[1]!, {
    resultMatch: {
      "!": true,
      "-": -10,
      "-(-)": 10,
    },
  });
});

// https://github.com/functionless/functionless/issues/150
test("assignment in object", () => {
  const templates = appsyncTestCase(() => {
    let y = 1;
    return { x: (y = 2), y };
  });

  testAppsyncVelocity(templates[1]!, {
    resultMatch: {
      x: 2,
      y: 2,
    },
  });
});

test("var args push", () => {
  const templates = appsyncTestCase(() => {
    const y1: number[] = [];
    const y2: number[] = [];
    const y3: number[] = [];
    const y4: number[] = [];
    const x = [1, 2, 3];
    y1.push(...x);
    y2.push(...x, 4);
    y3.push(0, ...x);
    y4.push(0, ...x, 4);
    return { y1, y2, y3, y4 };
  });

  testAppsyncVelocity(templates[1]!, {
    resultMatch: {
      y1: [1, 2, 3],
      y2: [1, 2, 3, 4],
      y3: [0, 1, 2, 3],
      y4: [0, 1, 2, 3, 4],
    },
  });
});

// https://github.com/functionless/functionless/issues/150
test("deconstruct variable", () => {
  const templates = appsyncTestCase<
    {
      a: string;
      bb: { value: string; [key: string]: string };
      c?: string;
      arr: string[];
      d: string;
    },
    string
  >(($context) => {
    const {
      a,
      bb: { ["value"]: b, ["a" + "b"]: z },
      c = "what",
      arr: [d, , e, f = "sir", ...arrRest],
      ...objRest
    } = $context.arguments;
    return a + b + c + d + e + f + objRest.d + arrRest[0] + z;
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: {
      a: "hello",
      bb: { value: "world", ab: "dynamic" },
      d: "endofobj",
      arr: ["is", "skipme", "up", undefined, "endofarray"],
    },
    resultMatch: "helloworldwhatisupsirendofobjendofarraydynamic",
  });
});

test("deconstruct parameter", () => {
  const templates = appsyncTestCase<any, string>(
    ({
      arguments: {
        a,
        bb: { value: b },
        c = "what",
        m = c,
        arr: [d, , e, f = "sir", ...arrRest],
        ...objRest
      },
    }) => {
      return a + b + c + d + e + f + objRest.d + arrRest[0] + m;
    }
  );

  testAppsyncVelocity(templates[1]!, {
    arguments: {
      a: "hello",
      bb: { value: "world" },
      d: "endofobj",
      arr: ["is", "skipme", "up", undefined, "endofarray"],
    },
    resultMatch: "helloworldwhatisupsirendofobjendofarraywhat",
  });
});

test("deconstruct for of", () => {
  const templates = appsyncTestCase<
    {
      items: {
        a: string;
        bb: { value: string };
        c?: string;
        arr: string[];
        d: string;
      }[];
    },
    string
  >(($context) => {
    for (const {
      a,
      bb: { value: b },
      c = "what",
      arr: [d, , e, f = "sir", ...arrRest],
      ...objRest
    } of $context.arguments.items) {
      return a + b + c + d + e + f + objRest.d + arrRest[0];
    }
    return "";
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: {
      items: [
        {
          a: "hello",
          bb: { value: "world" },
          d: "endofobj",
          arr: ["is", "skipme", "up", undefined, "endofarray"],
        },
      ],
    },
    resultMatch: "helloworldwhatisupsirendofobjendofarray",
  });
});

test("deconstruct map", () => {
  const templates = appsyncTestCase(
    (
      $context: AppsyncContext<
        {
          items: {
            a: string;
            bb: { value: string };
            c?: string;
            arr: string[];
            d: string;
          }[];
        },
        string[]
      >
    ) => {
      return $context.arguments.items.map(
        ({
          a,
          bb: { value: b },
          c = "what",
          arr: [d, , e, f = "sir", ...arrRest],
          ...objRest
        }) => {
          return a + b + c + d + e + f + objRest.d + arrRest[0];
        }
      );
    }
  );

  testAppsyncVelocity(templates[1]!, {
    arguments: {
      items: [
        {
          a: "hello",
          bb: { value: "world" },
          d: "endofobj",
          arr: ["is", "skipme", "up", undefined, "endofarray"],
        },
      ],
    },
    resultMatch: ["helloworldwhatisupsirendofobjendofarray"],
  });
});

test("deconstruct map chain", () => {
  const templates = appsyncTestCase(
    (
      $context: AppsyncContext<
        {
          items: { a: string; b: string }[];
        },
        string[]
      >
    ) => {
      return $context.arguments.items
        .map(({ a, b }) => ({ a: b, b: a }))
        .map(({ a, b }) => ({ a: a + b, b: b + a }))
        .map(({ a, b }) => a + b);
    }
  );

  testAppsyncVelocity(templates[1]!, {
    arguments: {
      items: [
        {
          a: "a",
          b: "b",
        },
      ],
    },
    resultMatch: ["baab"],
  });
});

test("deconstruct reduce", () => {
  const templates = appsyncTestCase<
    {
      items: {
        a: string;
        bb: { value: string };
        c?: string;
        arr: string[];
        d: string;
      }[];
    },
    string
  >(($context) => {
    return $context.arguments.items.reduce(
      (
        acc,
        {
          a,
          bb: { value: b },
          c = "what",
          arr: [d, , e, f = "sir", ...arrRest],
          ...objRest
        }
      ) => {
        return `${acc}${a + b + c + d + e + f + objRest.d + arrRest[0]}`;
      },
      ""
    );
  });

  testAppsyncVelocity(templates[1]!, {
    arguments: {
      items: [
        {
          a: "hello",
          bb: { value: "world" },
          d: "endofobj",
          arr: ["is", "skipme", "up", undefined, "endofarray"],
        },
      ],
    },
    resultMatch: "helloworldwhatisupsirendofobjendofarray",
  });
});
