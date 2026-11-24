package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateAndConsumeOnce(t *testing.T) {
	store := &Store{shares: make(map[string]Share)}
	body, _ := json.Marshal(createRequest{
		Ciphertext:       base64.StdEncoding.EncodeToString([]byte("encrypted")),
		ExpiresInSeconds: 300,
	})
	createReq := httptest.NewRequest(http.MethodPost, "/api/shares", bytes.NewReader(body))
	createRes := httptest.NewRecorder()
	store.create(createRes, createReq)
	if createRes.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createRes.Code, createRes.Body.String())
	}
	var created struct { ID string `json:"id"` }
	if err := json.Unmarshal(createRes.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("invalid create response: %v", err)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/shares/"+created.ID, nil)
	getRes := httptest.NewRecorder()
	store.get(getRes, getReq)
	if getRes.Code != http.StatusOK {
		t.Fatalf("first get status = %d", getRes.Code)
	}

	secondRes := httptest.NewRecorder()
	store.get(secondRes, getReq)
	if secondRes.Code != http.StatusNotFound {
		t.Fatalf("second get status = %d, want 404", secondRes.Code)
	}
}

func TestCreateRejectsInvalidTTL(t *testing.T) {
	store := &Store{shares: make(map[string]Share)}
	body, _ := json.Marshal(createRequest{
		Ciphertext:       base64.StdEncoding.EncodeToString([]byte("encrypted")),
		ExpiresInSeconds: 42,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/shares", bytes.NewReader(body))
	res := httptest.NewRecorder()
	store.create(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
}
