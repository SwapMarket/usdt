package main

import (
	"syscall/js"
)

// This calls a JS function from Go.
func main() {
	println("adding two numbers:", add(2, 3)) // expecting 5

	// Expose the `multiply` function to JavaScript
	js.Global().Set("multiply", js.FuncOf(multiply))
	// Keep the function active
	select {}
}

// This function is imported from JavaScript, as it doesn't define a body.
// You should define a function named 'add' in the WebAssembly 'env'
// module from JavaScript.
//
//export add
func add(x, y int) int

// This function is exported to JavaScript, so can be called using
// exports.multiply() in JavaScript.
//
//export multiply
//func multiply(x, y int) int {
//	return x * y
//}

func multiply(this js.Value, p []js.Value) interface{} {
	a := p[0].Int()
	b := p[1].Int()
	return a * b
}
