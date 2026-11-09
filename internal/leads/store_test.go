package leads

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestPaginationAndPersistence(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for n := 1; n <= 3; n++ {
		p, err := s.List(n, "", "")
		if err != nil {
			t.Fatal(err)
		}
		if len(p.Leads) != 50 || p.Total != 150 || p.TotalPages != 3 || p.Summary.Total != 150 {
			t.Fatalf("bad page %+v", p)
		}
		for _, l := range p.Leads {
			if seen[l.ID] {
				t.Fatal("duplicate lead")
			}
			seen[l.ID] = true
		}
	}
	if len(seen) != 150 {
		t.Fatal("missing leads")
	}
	if _, err = s.List(4, "", ""); err == nil {
		t.Fatal("accepted page 4")
	}
	p, _ := s.List(1, "", "")
	lead := p.Leads[0]
	for _, stage := range Stages() {
		lead, err = s.UpdateStage(lead.ID, stage, lead.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	next, _ := reopened.List(1, "", "")
	if next.Leads[0].Stage != "Contract Created" || next.Leads[0].Version != lead.Version {
		t.Fatal("stage did not persist")
	}
	if _, err = s.UpdateStage(lead.ID, "Negotiation", 1); err == nil {
		t.Fatal("stale update accepted")
	}
	if _, err = s.UpdateStage(lead.ID, "Bad stage", lead.Version); err == nil {
		t.Fatal("unknown stage accepted")
	}
	if _, err = s.UpdateStage("missing", "Negotiation", 1); err == nil {
		t.Fatal("unknown ID accepted")
	}
	empty, err := s.List(1, "no-such-lead-xyz", "")
	if err != nil || len(empty.Leads) != 0 || empty.TotalPages != 1 {
		t.Fatal("bad empty page")
	}
	filtered, err := s.List(1, "", "Contract Created")
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range filtered.Leads {
		if l.Stage != "Contract Created" {
			t.Fatal("stage filter ignored")
		}
	}
	found, _ := s.List(1, "LEAD-150", "")
	if len(found.Leads) != 1 || found.Leads[0].ID != "LEAD-150" {
		t.Fatal("search ignored")
	}
}
func TestConcurrentUpdates(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	success := make(chan bool, 10)
	for i := 0; i < 10; i++ {
		wg.Go(func() {
			_, err := s.UpdateStage("LEAD-001", "Negotiation", 1)
			success <- err == nil
			s.List(1, "", "")
		})
	}
	wg.Wait()
	close(success)
	n := 0
	for ok := range success {
		if ok {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("expected one winning update; got %d", n)
	}
}
func TestSaveFailureDoesNotChangeMemory(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.path = filepath.Join(t.TempDir(), "missing", "leads.json")
	if _, err = s.UpdateStage("LEAD-001", "Negotiation", 1); err == nil {
		t.Fatal("expected write error")
	}
	p, _ := s.List(1, "", "")
	if p.Leads[0].Stage != "Lead Captured" {
		t.Fatal("failed write changed memory")
	}
}
func TestMalformedStorageIsNotReset(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "leads.json"), []byte("broken"), 0600)
	if _, err := OpenStore(dir); err == nil {
		t.Fatal("reset invalid data")
	}
}
