import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, BookMarked, CheckCheck, History } from "lucide-react";
import { api, qs } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useToast } from "../context/ToastContext";
import { BookCover } from "../components/BookCover";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoanBadge,
  Pagination,
  TableSkeleton,
} from "../components/Ui";
import {
  daysFromToday,
  fmtDate,
  fmtShort,
  plural,
  relativeDay,
} from "../utils/format";

function stampFor(loan) {
  const n = daysFromToday(loan.dueDate);
  if (n < 0) return { cls: "late", text: `Overdue ${plural(-n, "day")}` };
  if (n === 0) return { cls: "soon", text: "Due today" };
  if (n <= 3) return { cls: "soon", text: `Due in ${plural(n, "day")}` };
  return { cls: "", text: `Due ${fmtShort(loan.dueDate)}` };
}

function Slip({ loan, onReturn, busy, completed }) {
  const book = loan.bookId || {};
  const s = stampFor(loan);
  return (
    <article className={`slip ${s.cls === "late" ? "late" : ""}`}>
      <BookCover
        book={{
          title: book.title || "Removed book",
          author: book.author || "",
          category: book.category || "",
        }}
        small
      />
      <div>
        <h3>
          {book.id ? (
            <Link to={`/books/${book.id}`}>{book.title}</Link>
          ) : (
            "Removed book"
          )}
        </h3>
        <p className="by">{book.author}</p>
        <dl className="slip-rows" style={{ margin: "12px 0 0" }}>
          <div>
            <dt>Borrowed</dt>
            <dd>{fmtDate(loan.borrowDate)}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{fmtDate(loan.dueDate)}</dd>
          </div>
        </dl>
        {completed ? (
          <LoanBadge status="returned" />
        ) : (
          <span
            className={`stamp ${s.cls}`}
            title={`Due ${relativeDay(loan.dueDate)}`}
          >
            {s.text}
          </span>
        )}
        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || completed}
            onClick={() => onReturn(loan)}
            aria-label={`${completed ? "Returned" : "Return"} ${book.title || "this book"}`}
          >
            <CheckCheck size={16} aria-hidden="true" />{" "}
            {completed ? "Returned" : "Return book"}
          </button>
        </div>
      </div>
    </article>
  );
}

export default function MyBorrowings() {
  const toast = useToast();
  const [tab, setTab] = useState("borrowed");
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [returnError, setReturnError] = useState("");
  const [completed, setCompleted] = useState(() => new Set());
  const saving = useRef(false);
  const viewKey = `${tab}:${page}`;
  const {
    data: snapshot,
    error,
    loading,
    retry,
  } = useAsync(
    async (signal) => {
      const result = await api.get(
        `/borrowings${qs({ status: tab, page, limit: tab === "borrowed" ? 50 : 10 })}`,
        { signal },
      );
      return { ...result, viewKey };
    },
    [tab, page],
  );
  const data = snapshot?.viewKey === viewKey ? snapshot : null;
  const counts = snapshot?.counts;
  const pick = (next) => {
    setTab(next);
    setPage(1);
  };
  const chooseReturn = (loan) => {
    setReturnError("");
    setConfirm(loan);
  };
  const cancelReturn = () => {
    if (!saving.current) {
      setConfirm(null);
      setReturnError("");
    }
  };

  const returnBook = async () => {
    if (!confirm || saving.current) return;
    saving.current = true;
    setBusy(true);
    setReturnError("");
    try {
      await api.put(`/borrowings/${confirm.id}`, { status: "returned" });
      setCompleted((ids) => new Set([...ids, confirm.id]));
      setConfirm(null);
      toast.success("Book returned. You can find it in History.");
      retry();
    } catch (err) {
      if (err.status === 409) {
        setCompleted((ids) => new Set([...ids, confirm.id]));
        setConfirm(null);
        toast.error(err.message);
        retry();
      } else {
        setReturnError(
          err.message || "The return could not be saved. Please try again.",
        );
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My borrowings</h1>
          <p>Manage your current loans and view your returned books.</p>
        </div>
        <div className="tabs" role="tablist" aria-label="Loan list">
          <button
            className="tab"
            role="tab"
            aria-selected={tab === "borrowed"}
            onClick={() => pick("borrowed")}
          >
            On loan {counts && <small>{counts.borrowed}</small>}
          </button>
          <button
            className="tab"
            role="tab"
            aria-selected={tab === "returned"}
            onClick={() => pick("returned")}
          >
            History {counts && <small>{counts.returned}</small>}
          </button>
        </div>
      </div>
      {counts?.overdue > 0 && (
        <div
          className="alert alert-error"
          role="alert"
          style={{ marginBottom: 8 }}
        >
          <AlertTriangle size={18} />
          <span>
            You have {plural(counts.overdue, "overdue book")}. Return your
            overdue books before borrowing again.
          </span>
        </div>
      )}
      {error && data && (
        <div className="alert alert-error" role="alert">
          <span>Your loan list could not be refreshed.</span>
          <button className="btn btn-sm" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {error && !data ? (
        <ErrorState error={error} onRetry={retry} />
      ) : !data ? (
        <TableSkeleton rows={3} />
      ) : tab === "borrowed" ? (
        data.data.length === 0 ? (
          <EmptyState
            icon={BookMarked}
            title="Nothing on loan"
            action={
              <Link to="/catalog" className="btn btn-primary">
                Browse the catalog
              </Link>
            }
          >
            When you borrow a book, its due date and return button appear here.
          </EmptyState>
        ) : (
          <div className="slips" aria-busy={loading || busy}>
            {data.data.map((loan) => (
              <Slip
                key={loan.id}
                loan={loan}
                onReturn={chooseReturn}
                busy={busy}
                completed={completed.has(loan.id)}
              />
            ))}
          </div>
        )
      ) : data.data.length === 0 ? (
        <EmptyState icon={History} title="No returned books yet">
          Your history fills in as you return books.
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" style={{ marginTop: 22 }}>
            <table className="table">
              <caption className="sr-only">Returned books</caption>
              <thead>
                <tr>
                  <th>Book</th>
                  <th>Borrowed</th>
                  <th>Returned</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((loan) => (
                  <tr key={loan.id}>
                    <td>
                      <div className="title-cell">
                        {loan.bookId?.title || "Removed book"}
                      </div>
                      <div className="sub">{loan.bookId?.author}</div>
                    </td>
                    <td className="num">{fmtDate(loan.borrowDate)}</td>
                    <td className="num">{fmtDate(loan.returnDate)}</td>
                    <td>
                      <LoanBadge status="returned" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pages={data.pages} onChange={setPage} />
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title="Return this book?"
          confirmLabel={busy ? "Returning..." : "Return book"}
          busy={busy}
          onConfirm={returnBook}
          onCancel={cancelReturn}
        >
          <p>
            Return “{confirm.bookId?.title || "this book"}”? It will move to
            History and one copy will become available again.
          </p>
          {returnError && (
            <div
              className="alert alert-error"
              role="alert"
              style={{ marginTop: 14 }}
            >
              {returnError}
            </div>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
