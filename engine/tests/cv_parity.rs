use aditor::cv::{self, Image, Interpolation, Morphology, Pixel};
use serde_json::{json, Value};
use std::path::Path;
fn float(v: &Value) -> f32 {
    match v.as_str() {
        Some("nan") => f32::NAN,
        Some("inf") => f32::INFINITY,
        Some("-inf") => f32::NEG_INFINITY,
        _ => v.as_f64().unwrap() as f32,
    }
}
fn image<T: Pixel>(v: &Value) -> Image<T> {
    Image::new(
        v["width"].as_u64().unwrap() as usize,
        v["height"].as_u64().unwrap() as usize,
        v["channels"].as_u64().unwrap() as usize,
        v["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| T::cast(float(v)))
            .collect(),
    )
    .unwrap()
}
fn number(n: f64) -> Value {
    if n.is_nan() {
        json!("nan")
    } else if n == f64::INFINITY {
        json!("inf")
    } else if n == f64::NEG_INFINITY {
        json!("-inf")
    } else {
        json!(n)
    }
}
fn value<T: Pixel>(img: Image<T>) -> Value {
    json!({"width":img.width,"height":img.height,"channels":img.channels,"data":img.data.into_iter().map(|v|number(v.float() as f64)).collect::<Vec<_>>()})
}
fn method(c: &Value) -> Interpolation {
    if c["method"] == "area" {
        Interpolation::Area
    } else {
        Interpolation::Linear
    }
}
fn run<T: Pixel>(c: &Value) -> Value {
    let src = image::<T>(&c["input"]);
    match c["op"].as_str().unwrap() {
        "resize" => value(
            cv::resize(
                &src,
                c["width"].as_u64().unwrap() as usize,
                c["height"].as_u64().unwrap() as usize,
                method(c),
            )
            .unwrap(),
        ),
        "resize_factor" => value(
            cv::resize_factor(
                &src,
                c["scale"].as_f64().unwrap(),
                c["scale"].as_f64().unwrap(),
                method(c),
            )
            .unwrap(),
        ),
        "gaussian" => {
            let k = c["kernel"].as_u64().unwrap() as usize;
            value(cv::gaussian_blur(&src, (k, k), c["sigma"].as_f64().unwrap()).unwrap())
        }
        "split" => Value::Array(src.split().into_iter().map(value).collect()),
        "border" => value(src.border(1, 2, 3, 1, T::default())),
        "match" => value(
            cv::match_template(
                &src,
                &image::<T>(&c["template"]),
                if c["mask"].is_null() {
                    None
                } else {
                    Some(image::<u8>(&c["mask"]))
                }
                .as_ref(),
            )
            .unwrap(),
        ),
        op => panic!("Unknown generic op: {op}"),
    }
}
fn run_case(c: &Value) -> Value {
    let src = || image::<u8>(&c["input"]);
    let kernel = || {
        let k = c["kernel"].as_u64().unwrap() as usize;
        cv::rect_kernel(k, k).unwrap()
    };
    match c["op"].as_str().unwrap() {
        "gray" => value(cv::gray(&src()).unwrap()),
        "hsv" => value(cv::hsv(&src()).unwrap()),
        "in_range" => value(
            cv::in_range(
                &src(),
                &serde_json::from_value::<Vec<u8>>(c["low"].clone()).unwrap(),
                &serde_json::from_value::<Vec<u8>>(c["high"].clone()).unwrap(),
            )
            .unwrap(),
        ),
        "morphology" => value(cv::morphology(
            &src(),
            &kernel(),
            match c["method"].as_str().unwrap() {
                "open" => Morphology::Open,
                "tophat" => Morphology::TopHat,
                _ => Morphology::BlackHat,
            },
        )),
        "dilate" => value(cv::dilate(
            &src(),
            &kernel(),
            c["iterations"].as_u64().unwrap() as usize,
        )),
        "box" => {
            let k = &c["kernel"];
            value(
                cv::box_filter(
                    &image::<f32>(&c["input"]),
                    (
                        k[0].as_u64().unwrap() as usize,
                        k[1].as_u64().unwrap() as usize,
                    ),
                    (0, 0),
                )
                .unwrap(),
            )
        }
        "min_max" => {
            let (lo, hi, lp, hp) = cv::min_max_loc(&image::<f32>(&c["input"]));
            json!([number(lo), number(hi), lp, hp])
        }
        "components" => {
            let result = cv::connected_components(&src()).unwrap();
            json!({"labels":result.labels,"stats":result.stats,"centroids":result.centroids.into_iter().map(|p|[number(p[0]),number(p[1])]).collect::<Vec<_>>()})
        }
        "png" => value(
            cv::read_png(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/parity/cv")
                    .join(c["file"].as_str().unwrap()),
                c["gray"].as_bool().unwrap(),
            )
            .unwrap(),
        ),
        _ => {
            if c["dtype"] == "uint8" {
                run::<u8>(c)
            } else {
                run::<f32>(c)
            }
        }
    }
}
fn difference(actual: &Value, expected: &Value, tolerance: f64, path: &str) -> Option<String> {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let diff = (a.as_f64().unwrap() - b.as_f64().unwrap()).abs();
            (diff > tolerance).then(|| format!("{path}: {a} != {b} (delta {diff})"))
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .find_map(|(i, (a, b))| difference(a, b, tolerance, &format!("{path}[{i}]"))),
        (Value::Object(a), Value::Object(b)) if a.len() == b.len() => b
            .iter()
            .find_map(|(k, b)| difference(&a[k], b, tolerance, &format!("{path}.{k}"))),
        _ => (actual != expected).then(|| format!("{path}: {actual} != {expected}")),
    }
}
fn max_error(actual: &Value, expected: &Value) -> f64 {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => (a.as_f64().unwrap() - b.as_f64().unwrap()).abs(),
        (Value::Array(a), Value::Array(b)) => a
            .iter()
            .zip(b)
            .map(|(a, b)| max_error(a, b))
            .fold(0., f64::max),
        (Value::Object(a), Value::Object(b)) => b
            .iter()
            .map(|(k, b)| max_error(&a[k], b))
            .fold(0., f64::max),
        _ => 0.,
    }
}
#[test]
fn cv_parity() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/cv/cases.json");
    let cases: Vec<Value> = serde_json::from_slice(
        &std::fs::read(&path).expect("Generate reference fixtures with tools/dump_parity.py"),
    )
    .unwrap();
    assert!(!cases.is_empty());
    let mut failures = Vec::new();
    let mut max_float_error = 0f64;
    for (i, c) in cases.iter().enumerate() {
        let actual = run_case(c);
        let float_result = c["dtype"] == "float32"
            || c["op"] == "match"
            || c["op"] == "min_max"
            || c["op"] == "components";
        if float_result {
            max_float_error = max_float_error.max(max_error(&actual, &c["expected"]));
        }
        if let Some(diff) = difference(
            &actual,
            &c["expected"],
            if float_result { 1e-4 } else { 0. },
            "",
        ) {
            failures.push(format!("case {i} {} {}: {diff}", c["op"], c["dtype"]));
        }
    }
    assert!(
        failures.is_empty(),
        "{} / {} parity cases failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    println!(
        "{} OpenCV parity cases passed; maximum float absolute error: {max_float_error:e}",
        cases.len()
    );
}

#[test]
fn extreme_resize_dimensions_return_errors_without_panicking() {
    let image = Image::new(2, 2, 3, vec![0u8; 12]).unwrap();
    for (w, h) in [(usize::MAX, 2), (usize::MAX / 2, 1), (0, 1)] {
        assert!(cv::resize(&image, w, h, cv::Interpolation::Linear).is_err());
    }
    assert!(cv::resize_factor(&image, 1e100, 1e100, cv::Interpolation::Linear).is_err());
}
