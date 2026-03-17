package crawler

import (
	"fmt"
	"testing"
	"time"

	"github.com/yo4raw/smilezemi-notification/internal/data"
)

// ---- maskName ----

func TestMaskName_Empty(t *testing.T) {
	if got := maskName(""); got != "" {
		t.Errorf("maskName(\"\") = %q, want \"\"", got)
	}
}

func TestMaskName_SingleRune(t *testing.T) {
	if got := maskName("A"); got != "A" {
		t.Errorf("maskName(\"A\") = %q, want \"A\"", got)
	}
}

func TestMaskName_SingleJapaneseRune(t *testing.T) {
	if got := maskName("あ"); got != "あ" {
		t.Errorf("maskName(\"あ\") = %q, want \"あ\"", got)
	}
}

func TestMaskName_TwoRunes(t *testing.T) {
	if got := maskName("AB"); got != "*B" {
		t.Errorf("maskName(\"AB\") = %q, want \"*B\"", got)
	}
}

func TestMaskName_MultiByteRunes(t *testing.T) {
	// "たろう" (3 runes) → "**う"
	if got := maskName("たろう"); got != "**う" {
		t.Errorf("maskName(\"たろう\") = %q, want \"**う\"", got)
	}
}

func TestMaskName_MixedASCII(t *testing.T) {
	// "abcd" (4 chars) → "***d"
	if got := maskName("abcd"); got != "***d" {
		t.Errorf("maskName(\"abcd\") = %q, want \"***d\"", got)
	}
}

func TestMaskName_LastCharPreserved(t *testing.T) {
	// Only the last rune should be visible.
	input := "山田太郎"
	got := maskName(input)
	runes := []rune(got)
	last := []rune(input)[len([]rune(input))-1]
	if runes[len(runes)-1] != last {
		t.Errorf("maskName(%q) last char = %q, want %q", input, runes[len(runes)-1], last)
	}
	// All but last should be '*'
	for i, r := range runes[:len(runes)-1] {
		if r != '*' {
			t.Errorf("maskName(%q)[%d] = %q, want '*'", input, i, r)
		}
	}
}

// ---- parseStudyTime ----

func TestParseStudyTime_HoursAndMinutes(t *testing.T) {
	h, m, err := parseStudyTime("1時間30分")
	if err != nil || h != 1 || m != 30 {
		t.Errorf("parseStudyTime(\"1時間30分\") = (%d,%d,%v), want (1,30,nil)", h, m, err)
	}
}

func TestParseStudyTime_MinutesOnly(t *testing.T) {
	h, m, err := parseStudyTime("45分")
	if err != nil || h != 0 || m != 45 {
		t.Errorf("parseStudyTime(\"45分\") = (%d,%d,%v), want (0,45,nil)", h, m, err)
	}
}

func TestParseStudyTime_HoursOnly(t *testing.T) {
	h, m, err := parseStudyTime("2時間")
	if err != nil || h != 2 || m != 0 {
		t.Errorf("parseStudyTime(\"2時間\") = (%d,%d,%v), want (2,0,nil)", h, m, err)
	}
}

func TestParseStudyTime_MinutesGe60(t *testing.T) {
	// 75 minutes → 1h15m
	h, m, err := parseStudyTime("75分")
	if err != nil || h != 1 || m != 15 {
		t.Errorf("parseStudyTime(\"75分\") = (%d,%d,%v), want (1,15,nil)", h, m, err)
	}
}

func TestParseStudyTime_MinutesExactly60(t *testing.T) {
	h, m, err := parseStudyTime("60分")
	if err != nil || h != 1 || m != 0 {
		t.Errorf("parseStudyTime(\"60分\") = (%d,%d,%v), want (1,0,nil)", h, m, err)
	}
}

func TestParseStudyTime_HoursAndMinutesGe60(t *testing.T) {
	// "1時間90分" → 1h + (90m → 1h30m) = 2h30m
	h, m, err := parseStudyTime("1時間90分")
	if err != nil || h != 2 || m != 30 {
		t.Errorf("parseStudyTime(\"1時間90分\") = (%d,%d,%v), want (2,30,nil)", h, m, err)
	}
}

func TestParseStudyTime_NoMatch(t *testing.T) {
	h, m, err := parseStudyTime("勉強時間なし")
	if err != nil || h != 0 || m != 0 {
		t.Errorf("parseStudyTime(\"勉強時間なし\") = (%d,%d,%v), want (0,0,nil)", h, m, err)
	}
}

func TestParseStudyTime_EmptyString(t *testing.T) {
	h, m, err := parseStudyTime("")
	if err != nil || h != 0 || m != 0 {
		t.Errorf("parseStudyTime(\"\") = (%d,%d,%v), want (0,0,nil)", h, m, err)
	}
}

func TestParseStudyTime_ZeroHoursZeroMinutes(t *testing.T) {
	h, m, err := parseStudyTime("0時間0分")
	if err != nil || h != 0 || m != 0 {
		t.Errorf("parseStudyTime(\"0時間0分\") = (%d,%d,%v), want (0,0,nil)", h, m, err)
	}
}

func TestParseStudyTime_LargeValues(t *testing.T) {
	h, m, err := parseStudyTime("10時間120分")
	// 120分 → 2時間, total 10+2=12時間0分
	if err != nil || h != 12 || m != 0 {
		t.Errorf("parseStudyTime(\"10時間120分\") = (%d,%d,%v), want (12,0,nil)", h, m, err)
	}
}

// ---- getTodayDate ----

func TestGetTodayDate_Format(t *testing.T) {
	withPadding, withoutPadding := getTodayDate()

	now := time.Now()
	month := int(now.Month())
	day := now.Day()

	// withPadding: zero-padded MM/DD
	wantPadding := fmt.Sprintf("%02d/%02d", month, day)
	if withPadding != wantPadding {
		t.Errorf("getTodayDate() withPadding = %q, want %q", withPadding, wantPadding)
	}

	// withoutPadding: no zero-padding M/D
	wantNoPadding := fmt.Sprintf("%d/%d", month, day)
	if withoutPadding != wantNoPadding {
		t.Errorf("getTodayDate() withoutPadding = %q, want %q", withoutPadding, wantNoPadding)
	}
}

func TestGetTodayDate_SlashSeparator(t *testing.T) {
	withPadding, withoutPadding := getTodayDate()
	for _, s := range []string{withPadding, withoutPadding} {
		if len(s) < 3 {
			t.Errorf("getTodayDate() returned too short string: %q", s)
			continue
		}
		hasSlash := false
		for _, c := range s {
			if c == '/' {
				hasSlash = true
				break
			}
		}
		if !hasSlash {
			t.Errorf("getTodayDate() = %q does not contain '/'", s)
		}
	}
}

// ---- GetTotalScore ----

func TestGetTotalScore_Empty(t *testing.T) {
	if got := GetTotalScore(nil); got != 0 {
		t.Errorf("GetTotalScore(nil) = %d, want 0", got)
	}
}

func TestGetTotalScore_EmptySlice(t *testing.T) {
	if got := GetTotalScore([]data.Mission{}); got != 0 {
		t.Errorf("GetTotalScore([]) = %d, want 0", got)
	}
}

func TestGetTotalScore_SingleMission(t *testing.T) {
	missions := []data.Mission{{Name: "算数", Score: 80, Completed: true}}
	if got := GetTotalScore(missions); got != 80 {
		t.Errorf("GetTotalScore(single) = %d, want 80", got)
	}
}

func TestGetTotalScore_MultipleMissions(t *testing.T) {
	missions := []data.Mission{
		{Name: "算数", Score: 80, Completed: true},
		{Name: "国語", Score: 60, Completed: true},
		{Name: "理科", Score: 100, Completed: false},
	}
	if got := GetTotalScore(missions); got != 240 {
		t.Errorf("GetTotalScore(multiple) = %d, want 240", got)
	}
}

func TestGetTotalScore_ZeroScores(t *testing.T) {
	missions := []data.Mission{
		{Name: "算数", Score: 0, Completed: true},
		{Name: "国語", Score: 0, Completed: false},
	}
	if got := GetTotalScore(missions); got != 0 {
		t.Errorf("GetTotalScore(zeros) = %d, want 0", got)
	}
}

func TestGetTotalScore_CompletedFlagIgnored(t *testing.T) {
	// Score summation must not depend on Completed flag.
	m1 := []data.Mission{{Name: "A", Score: 50, Completed: true}}
	m2 := []data.Mission{{Name: "A", Score: 50, Completed: false}}
	if GetTotalScore(m1) != GetTotalScore(m2) {
		t.Error("GetTotalScore should not depend on the Completed field")
	}
}

// ---- escapeJS ----

func TestEscapeJS_NoSpecialChars(t *testing.T) {
	if got := escapeJS("hello"); got != "hello" {
		t.Errorf("escapeJS(\"hello\") = %q, want \"hello\"", got)
	}
}

func TestEscapeJS_Backslash(t *testing.T) {
	// Single backslash → double backslash
	if got := escapeJS(`\`); got != `\\` {
		t.Errorf(`escapeJS("\\") = %q, want "\\\\"`, got)
	}
}

func TestEscapeJS_SingleQuote(t *testing.T) {
	if got := escapeJS("it's"); got != `it\'s` {
		t.Errorf("escapeJS(\"it's\") = %q, want \"it\\'s\"", got)
	}
}

func TestEscapeJS_DoubleQuote(t *testing.T) {
	if got := escapeJS(`say "hi"`); got != `say \"hi\"` {
		t.Errorf(`escapeJS(say "hi") = %q, want "say \"hi\""`, got)
	}
}

func TestEscapeJS_Newline(t *testing.T) {
	if got := escapeJS("line1\nline2"); got != `line1\nline2` {
		t.Errorf("escapeJS with newline = %q, want \"line1\\nline2\"", got)
	}
}

func TestEscapeJS_CombinedSpecials(t *testing.T) {
	input := "a\\b'c\"d\ne"
	want := `a\\b\'c\"d\ne`
	if got := escapeJS(input); got != want {
		t.Errorf("escapeJS(combined) = %q, want %q", got, want)
	}
}

func TestEscapeJS_MultipleBackslashes(t *testing.T) {
	if got := escapeJS(`\\`); got != `\\\\` {
		t.Errorf(`escapeJS("\\\\") = %q, want "\\\\\\\\"`, got)
	}
}

func TestEscapeJS_Empty(t *testing.T) {
	if got := escapeJS(""); got != "" {
		t.Errorf("escapeJS(\"\") = %q, want \"\"", got)
	}
}

func TestEscapeJS_JapaneseUnchanged(t *testing.T) {
	input := "たろうさん"
	if got := escapeJS(input); got != input {
		t.Errorf("escapeJS(japanese) = %q, want %q", got, input)
	}
}

// ---- contains / containsStr ----

func TestContains_EmptyS(t *testing.T) {
	if contains("", "abc") {
		t.Error("contains(\"\", \"abc\") should be false")
	}
}

func TestContains_EmptySubstr(t *testing.T) {
	if contains("abc", "") {
		t.Error("contains(\"abc\", \"\") should be false")
	}
}

func TestContains_BothEmpty(t *testing.T) {
	if contains("", "") {
		t.Error("contains(\"\", \"\") should be false")
	}
}

func TestContains_SubstrLongerThanS(t *testing.T) {
	if contains("ab", "abc") {
		t.Error("contains(\"ab\", \"abc\") should be false")
	}
}

func TestContains_ExactMatch(t *testing.T) {
	if !contains("abc", "abc") {
		t.Error("contains(\"abc\", \"abc\") should be true")
	}
}

func TestContains_PrefixMatch(t *testing.T) {
	if !contains("guidance-report/foo", "guidance-report") {
		t.Error("contains should match prefix")
	}
}

func TestContains_SuffixMatch(t *testing.T) {
	if !contains("foobar", "bar") {
		t.Error("contains should match suffix")
	}
}

func TestContains_MiddleMatch(t *testing.T) {
	if !contains("foobarqux", "bar") {
		t.Error("contains should match middle substring")
	}
}

func TestContains_NoMatch(t *testing.T) {
	if contains("hello", "xyz") {
		t.Error("contains(\"hello\", \"xyz\") should be false")
	}
}

func TestContainsStr_SingleChar(t *testing.T) {
	if !containsStr("abc", "b") {
		t.Error("containsStr(\"abc\", \"b\") should be true")
	}
}

func TestContainsStr_NotPresent(t *testing.T) {
	if containsStr("abc", "d") {
		t.Error("containsStr(\"abc\", \"d\") should be false")
	}
}

// ---- orDefault ----

func TestOrDefault_NonEmpty(t *testing.T) {
	if got := orDefault("value", "default"); got != "value" {
		t.Errorf("orDefault(\"value\", \"default\") = %q, want \"value\"", got)
	}
}

func TestOrDefault_Empty(t *testing.T) {
	if got := orDefault("", "default"); got != "default" {
		t.Errorf("orDefault(\"\", \"default\") = %q, want \"default\"", got)
	}
}

func TestOrDefault_EmptyDefault(t *testing.T) {
	if got := orDefault("", ""); got != "" {
		t.Errorf("orDefault(\"\", \"\") = %q, want \"\"", got)
	}
}

func TestOrDefault_NonEmptyWithEmptyDefault(t *testing.T) {
	if got := orDefault("hello", ""); got != "hello" {
		t.Errorf("orDefault(\"hello\", \"\") = %q, want \"hello\"", got)
	}
}

func TestOrDefault_JapaneseValue(t *testing.T) {
	if got := orDefault("", "取得できませんでした"); got != "取得できませんでした" {
		t.Errorf("orDefault with japanese default = %q", got)
	}
}
