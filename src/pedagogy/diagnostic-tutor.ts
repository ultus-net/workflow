import type { DiagnosticLesson, PedagogicalMode } from "./contracts.js";

export interface DiagnosticInput {
  readonly code: number;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export function createDiagnosticLesson(
  diagnostic: DiagnosticInput,
  mode: PedagogicalMode,
): DiagnosticLesson {
  const { code, message, file, line, column } = diagnostic;

  switch (code) {
    case 2322: // Type 'X' is not assignable to type 'Y'
      return {
        code,
        file,
        line,
        column,
        mode,
        plainEnglishExplanation:
          mode === "learn-to-code"
            ? "The value you are trying to use does not fit the type that this variable or property was created to hold."
            : "Type assignment incompatibility: the provided value's type violates the declared target contract.",
        underlyingPrinciple:
          "Static type safety ensures operations valid on one type are never accidentally executed on an incompatible type at runtime.",
        guidingHints:
          mode === "learn-to-code"
            ? [
                "Look at what type the variable was declared with (like string or number).",
                "Check the value you are giving it on this line.",
                "Convert the value using a conversion function (like String() or Number()) if needed.",
              ]
            : [
                "Inspect the structural difference between the source and target types.",
                "Determine whether the target type should be a union or if the incoming value requires mapping.",
              ],
      };

    case 2345: // Argument of type 'X' is not assignable to parameter of type 'Y'
      return {
        code,
        file,
        line,
        column,
        mode,
        plainEnglishExplanation:
          mode === "learn-to-code"
            ? "You called a function, but passed an argument that is a different type than what the function expects."
            : "Function call argument mismatch: argument type violates the declared parameter contract.",
        underlyingPrinciple:
          "Functions rely on preconditions; callers must satisfy the parameter type contract to guarantee safe execution.",
        guidingHints:
          mode === "learn-to-code"
            ? [
                "Check the function definition to see what type each parameter expects.",
                "Ensure you are passing arguments in the correct order.",
              ]
            : [
                "Check if nullable or optional values need narrowing before being passed.",
                "Verify if the function should accept generic parameters or a broader union.",
              ],
      };

    case 2531:
    case 2532:
    case 2533:
    case 18047:
    case 18048: // Object is possibly 'null' or 'undefined'
      return {
        code,
        file,
        line,
        column,
        mode,
        plainEnglishExplanation:
          mode === "learn-to-code"
            ? "You are trying to read a property from a variable that might be empty (null or undefined), which would crash your program."
            : "Possible null/undefined dereference: strict null checks detect unvalidated nullable access.",
        underlyingPrinciple:
          "Strict null safety prevents 'TypeError: Cannot read properties of undefined' crashes at compile time.",
        guidingHints:
          mode === "learn-to-code"
            ? [
                "Use optional chaining (?.) so accessing the property returns undefined instead of crashing.",
                "Add an if check (if (myVariable !== undefined) { ... }) to make sure it exists before using it.",
                "Use the nullish coalescing operator (??) to provide a default fallback value.",
              ]
            : [
                "Narrow with a type guard or truthiness check before dereferencing.",
                "Leverage optional chaining (?.) or nullish coalescing (??) for safe fallbacks.",
              ],
      };

    default:
      return {
        code,
        file,
        line,
        column,
        mode,
        plainEnglishExplanation: `Compiler diagnostic: ${message}`,
        underlyingPrinciple:
          "Static analysis catches potential bugs and contract violations before the code is executed.",
        guidingHints: [
          "Examine the source code at this location.",
          "Check the types and declarations of related variables and functions.",
        ],
      };
  }
}
